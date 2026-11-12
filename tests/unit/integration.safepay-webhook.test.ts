import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import { bindCheckoutOwner } from "@/services/safepay-attempt.store";
import { trackerIdentity, type VerificationInput } from "@/lib/payments/evidence-contract";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import type { PaymentPersistence } from "@/services/payment-settlement.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { adminUpdateOrderStatus } from "@/services/orders.service";

// End-to-end sandbox verification path: documented signed webhook â†’ HMAC-SHA512
// authentication (real registry, no mock) â†’ tracker resolution â†’ durable inbox â†’
// settlement. No real provider call is required or permitted.
assertDisposableTestDatabase();

process.env.SAFEPAY_ENVIRONMENT = "sandbox";
process.env.SAFEPAY_ENTRY_MODE = "flex";
process.env.SAFEPAY_MERCHANT_API_KEY = "synthetic-public";
process.env.SAFEPAY_SECRET_KEY = "synthetic-secret";
process.env.SAFEPAY_RETURN_STATE_SECRET = "synthetic-independent-return-key-at-least-32-bytes";
process.env.SAFEPAY_MERCHANT_ACCOUNT_REF = "synthetic-account";
process.env.SAFEPAY_SITE_ORIGIN = "https://shop.example.invalid";
process.env.SAFEPAY_WEBHOOK_SECRET = "synthetic-webhook-secret-0123456789abcdef";

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return { db: new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }) };
});
import { db } from "@/lib/db";

const vaultKey = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".slice(0, 32));
const vault = createPaymentPayloadVault("integration", new Map([["integration", new Uint8Array(vaultKey)]]));
const inbox = createPaymentWebhookService(db as unknown as PaymentPersistence, vault, { reconcileDelayMs: 60_000 });

const orders: string[] = [], products: string[] = [], categories: string[] = [], users: string[] = [], events: string[] = [];

async function fixture() {
  const now = new Date();
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid", emailVerified: now } });
  users.push(user.id);
  const binding = bindCheckoutOwner({ kind: "USER", userId: user.id });
  const category = await db.category.create({ data: { name: "Webhook synthetic " + randomUUID(), slug: randomUUID() } });
  categories.push(category.id);
  const product = await db.product.create({ data: {
    name: "Synthetic webhook product", slug: randomUUID(), categoryId: category.id, price: 1000,
    inventory: { create: { quantity: 3 } },
  }, include: { inventory: true } });
  products.push(product.id);
  const order = await db.$transaction(async tx => {
    const created = await tx.order.create({ data: {
      reference: "SFP-" + randomUUID(), idempotencyKey: randomUUID(), isGuest: false,
      user: { connect: { id: user.id } },
      customerName: "Synthetic", customerEmail: "synthetic@example.invalid", customerPhone: "03000000000",
      shipFullName: "Synthetic", shipPhone: "03000000000", shipLine1: "Synthetic", shipCity: "Test", shipProvince: "Test",
      paymentMethod: "ONLINE", status: "PENDING", paymentStatus: "PENDING", paymentFlowVersion: 1,
      nextPaymentAttempt: 2, currency: "PKR", subtotal: 1000, total: 1000,
      checkoutOwnerKind: "USER", checkoutOwnerHash: binding.hash, checkoutFingerprint: "a".repeat(64),
      checkoutAccessExpiresAt: new Date(now.getTime() + 600000), reservationExpiresAt: new Date(now.getTime() + 600000),
      paymentReviewStatus: "CLEAR",
      items: { create: { productId: product.id, productName: product.name, productSlug: product.slug, quantity: 1, unitPrice: 1000, lineTotal: 1000 } },
      payments: { create: {
        provider: "SAFEPAY", amount: 1000, currency: "PKR", attemptNumber: 1, attemptState: "CHECKOUT_ISSUED",
        providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account", expectedAmountMinor: BigInt(100000),
        reconcileStatus: "PENDING", creationStartedAt: now, trackerBoundAt: now,
      } },
    }, include: { items: true, payments: true } });
    await tx.inventoryReservation.create({ data: {
      orderItemId: created.items[0].id, inventoryId: product.inventory!.id, quantity: 1,
    } });
    await tx.order.update({ where: { id: created.id }, data: { paymentOwnerOrderId: created.id, activePaymentId: created.payments[0].id } });
    return created;
  });
  orders.push(order.id);
  const payment = order.payments[0];
  const token = "synthetic-webhook-" + randomUUID();
  await db.payment.update({ where: { id: payment.id }, data: {
    trackerToken: token,
    trackerIdentityKey: trackerIdentity({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", trackerToken: token }),
  } });
  return { order, paymentId: payment.id, token, product, userId: user.id };
}

function signedDelivery(token: string, type = "payment.succeeded", failedState = "TRACKER_ENROLLED"): VerificationInput {
  // Documented hosted-checkout webhook shapes (getsafepay/safepay-docs):
  // data.tracker is a STRING with state/amount/currency as siblings; payment.succeeded
  // carries the financial fields, payment.failed does not.
  const body = JSON.stringify({
    token: "evt_" + token.slice(-12),
    version: "2.0.0",
    merchant_api_key: "synthetic-public",
    type,
    endpoint: "https://shop.example.invalid/api/webhooks/safepay",
    data: type === "payment.succeeded" ? {
      tracker: token,
      intent: "CYBERSOURCE",
      state: "TRACKER_ENDED",
      amount: 100000,
      currency: "PKR",
      charged_at: { seconds: 1698754230, nanos: 752997627 },
    } : {
      tracker: token,
      intent: "CYBERSOURCE",
      state: failedState,
      category: "PAYMENT_METHOD_ERROR",
      code: 403,
      message: "The card you have used has been flagged as either stolen or lost.",
      failed_at: { seconds: 1698754648, nanos: 494424793 },
    },
    created_at: { seconds: 1698754230, nanos: 912705711 },
  });
  return {
    provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    channel: "WEBHOOK", body: Buffer.from(body),
    headers: { "x-sfpy-signature": createHmac("sha512", process.env.SAFEPAY_WEBHOOK_SECRET!)
      .update(Buffer.from(body)).digest("hex") },
  };
}

afterAll(async () => {
  const orderIds = [...orders];
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orderIds } } } });
  await db.paymentWebhookEvent.deleteMany({ where: { OR: [{ id: { in: events } }, { payment: { orderId: { in: orderIds } } }] } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orderIds } } } });
  await db.order.updateMany({ where: { id: { in: orderIds } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.product.deleteMany({ where: { id: { in: products } } });
  await db.category.deleteMany({ where: { id: { in: categories } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("Signed webhook to settled order", () => {
  it("settles a managed order from one authenticated delivery", async () => {
    const f = await fixture();
    const received = await inbox.receive(signedDelivery(f.token));
    if (received.kind !== "stored") throw new Error("Expected durable storage: " + JSON.stringify(received));
    events.push(received.eventId);

    const settled = await inbox.process(received.eventId);
    expect(settled).toEqual({ kind: "settled" });

    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id }, include: {
      items: { include: { inventoryReservation: true } }, payments: true } });
    expect(order.status).toBe("CONFIRMED");
    expect(order.paymentStatus).toBe("PAID");
    expect(order.acceptedPaymentId).toBe(f.paymentId);
    expect(order.items[0].inventoryReservation!.state).toBe("CONSUMED");
    const payment = order.payments[0];
    expect(payment.status).toBe("PAID");
    expect(payment.attemptState).toBe("SETTLED");
    expect(payment.reconcileStatus).toBe("VERIFIED");
    expect(payment.capturedAmountMinor).toBe(BigInt(100000));
    const evidence = await db.paymentEvidence.findMany({ where: { paymentId: f.paymentId } });
    expect(evidence.some(row => row.source === "WEBHOOK" && row.decision === "SETTLED")).toBe(true);
    // Stock was already decremented when the reservation was HELD; settlement must not double-decrement.
    const inventory = await db.inventory.findUniqueOrThrow({ where: { productId: f.product.id } });
    expect(inventory.quantity).toBe(3);
  });

  it("is idempotent across provider redeliveries of the same signed event", async () => {
    const f = await fixture();
    const delivery = signedDelivery(f.token);
    const first = await inbox.receive(delivery);
    if (first.kind !== "stored") throw new Error("Expected durable storage");
    events.push(first.eventId);
    expect(await inbox.process(first.eventId)).toEqual({ kind: "settled" });

    const redelivered = await inbox.receive(delivery);
    if (redelivered.kind === "blocked") throw new Error("Unexpected blocked redelivery");
    expect(redelivered.kind).toBe("duplicate");
    expect(redelivered.eventId).toBe(first.eventId);
    expect(await inbox.process(first.eventId)).toEqual({ kind: "duplicate" });

    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(order.paymentStatus).toBe("PAID");
    expect(order.status).toBe("CONFIRMED");
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment.reconcileAttempts).toBe(1);
  });

  it("quarantines a delivery whose signature does not verify and moves no money", async () => {
    const f = await fixture();
    const tampered: VerificationInput = { ...signedDelivery(f.token),
      headers: { "x-sfpy-signature": "f".repeat(128) } };
    const received = await inbox.receive(tampered);
    if (received.kind === "blocked") throw new Error("Unexpected blocked delivery");
    expect(received.kind).toBe("quarantined");
    events.push(received.eventId);
    const processed = await inbox.process(received.eventId);
    expect(processed.kind).toBe("review_required");
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(order.paymentStatus).toBe("PENDING");
    expect(order.status).toBe("PENDING");
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment.status).toBe("PENDING");
  });

  it("records a documented payment.failed observation without releasing reservations", async () => {
    const f = await fixture();
    const received = await inbox.receive(signedDelivery(f.token, "payment.failed"));
    if (received.kind !== "stored") throw new Error("Expected durable storage: " + JSON.stringify(received));
    events.push(received.eventId);
    const processed = await inbox.process(received.eventId);
    expect(processed).toEqual({ kind: "recorded" });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id }, include: {
      items: { include: { inventoryReservation: true } } } });
    expect(order.status).toBe("PENDING");
    expect(order.paymentStatus).toBe("PENDING");
    expect(order.items[0].inventoryReservation!.state).toBe("HELD");
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment.status).toBe("PENDING");
    expect(payment.reconcileStatus).toBe("UNCERTAIN");
    expect(payment.nextReconcileAt).not.toBeNull();
    const evidence = await db.paymentEvidence.findMany({ where: { paymentId: f.paymentId } });
    expect(evidence.some(row => row.source === "WEBHOOK" && row.decision === "OBSERVATION_RECORDED")).toBe(true);
  });

  it("routes contradictory failure evidence (failed while TRACKER_ENDED) to review and retains holds", async () => {
    const f = await fixture();
    const received = await inbox.receive(signedDelivery(f.token, "payment.failed", "TRACKER_ENDED"));
    if (received.kind !== "stored") throw new Error("Expected durable storage: " + JSON.stringify(received));
    events.push(received.eventId);
    const processed = await inbox.process(received.eventId);
    expect(processed).toEqual({ kind: "review_required" });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id }, include: {
      items: { include: { inventoryReservation: true } } } });
    expect(order.status).toBe("PENDING");
    expect(order.paymentReviewStatus).toBe("REQUIRED");
    expect(order.items[0].inventoryReservation!.state).toBe("HELD");
  });

  it("quarantines capture evidence whose amount contradicts the expected attempt amount", async () => {
    const f = await fixture();
    const delivery = signedDelivery(f.token);
    const wrongAmount = JSON.parse(new TextDecoder().decode(delivery.body));
    wrongAmount.data.amount = 1;
    const body = Buffer.from(JSON.stringify(wrongAmount));
    const tamperedAmount: VerificationInput = { ...delivery, body,
      headers: { "x-sfpy-signature": createHmac("sha512", process.env.SAFEPAY_WEBHOOK_SECRET!)
        .update(body).digest("hex") } };
    const received = await inbox.receive(tamperedAmount);
    if (received.kind === "blocked") throw new Error("Unexpected blocked delivery");
    expect(received.kind).toBe("quarantined");
    events.push(received.eventId);
    expect(await inbox.process(received.eventId)).toEqual({ kind: "review_required" });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(order.paymentStatus).toBe("PENDING");
    expect(order.status).toBe("PENDING");
  });
  it("replays the same signed webhook three times without duplicate settlement", async () => {
    const f = await fixture();
    const delivery = signedDelivery(f.token);

    const first = await inbox.receive(delivery);
    if (first.kind !== "stored") {
      throw new Error("Expected first delivery to be stored");
    }
    events.push(first.eventId);

    expect(await inbox.process(first.eventId))
      .toEqual({ kind: "settled" });

    const second = await inbox.receive(delivery);
    const third = await inbox.receive(delivery);

    expect(second.kind).toBe("duplicate");
    expect(third.kind).toBe("duplicate");

    if (second.kind === "blocked" || third.kind === "blocked") {
      throw new Error("Unexpected blocked duplicate");
    }

    expect(second.eventId).toBe(first.eventId);
    expect(third.eventId).toBe(first.eventId);

    const stored = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: first.eventId },
    });

    expect(stored.deliveryCount).toBe(3);

    expect(await inbox.process(first.eventId))
      .toEqual({ kind: "duplicate" });

    const evidence = await db.paymentEvidence.findMany({
      where: {
        paymentId: f.paymentId,
        source: "WEBHOOK",
        decision: "SETTLED",
      },
    });

    expect(evidence).toHaveLength(1);

    const order = await db.order.findUniqueOrThrow({
      where: { id: f.order.id },
    });

    expect(order.status).toBe("CONFIRMED");
    expect(order.paymentStatus).toBe("PAID");
    expect(order.acceptedPaymentId).toBe(f.paymentId);
  });

  it("uses the signed body, not an unsigned event header, for fallback replay identity", async () => {
    const f = await fixture();
    const delivery = signedDelivery(f.token);
    const payload = JSON.parse(new TextDecoder().decode(delivery.body));
    delete payload.token;
    const body = Buffer.from(JSON.stringify(payload));
    const signature = createHmac("sha512", process.env.SAFEPAY_WEBHOOK_SECRET!)
      .update(body).digest("hex");
    const first = await inbox.receive({
      ...delivery,
      body,
      headers: { "x-sfpy-signature": signature, "x-sfpy-event-id": "unsigned-id-one" },
    });
    if (first.kind !== "stored") throw new Error("Expected first delivery to be stored");
    events.push(first.eventId);

    const replay = await inbox.receive({
      ...delivery,
      body,
      headers: { "x-sfpy-signature": signature, "x-sfpy-event-id": "unsigned-id-two" },
    });
    expect(replay).toEqual({ kind: "duplicate", eventId: first.eventId });
  });

  it("preserves a late-capture warning after a later uncertain observation", async () => {
    const f = await fixture();
    const closed = await adminUpdateOrderStatus(f.order.id, "CANCELLED");
    expect(closed).toMatchObject({ ok: true });

    const withEventToken = (delivery: VerificationInput, token: string): VerificationInput => {
      const payload = JSON.parse(new TextDecoder().decode(delivery.body));
      payload.token = token;
      const body = Buffer.from(JSON.stringify(payload));
      return {
        ...delivery,
        body,
        headers: {
          "x-sfpy-signature": createHmac("sha512", process.env.SAFEPAY_WEBHOOK_SECRET!)
            .update(body).digest("hex"),
        },
      };
    };

    const capture = await inbox.receive(withEventToken(signedDelivery(f.token), "late-capture-event"));
    if (capture.kind !== "stored") throw new Error("Expected late capture to be stored");
    events.push(capture.eventId);
    expect(await inbox.process(capture.eventId)).toEqual({ kind: "review_required" });
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } }))
      .toMatchObject({ paymentReviewStatus: "REQUIRED", paymentReviewReason: "LATE_CAPTURE" });

    const uncertain = await inbox.receive(
      withEventToken(signedDelivery(f.token, "payment.failed"), "later-uncertain-event")
    );
    if (uncertain.kind !== "stored") throw new Error("Expected uncertain event to be stored");
    events.push(uncertain.eventId);
    expect(await inbox.process(uncertain.eventId)).toEqual({ kind: "review_required" });
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } }))
      .toMatchObject({ paymentReviewStatus: "REQUIRED", paymentReviewReason: "LATE_CAPTURE" });
  });

  it("quarantines conflicting signed events with the same event ID", async () => {
    const f = await fixture();

    const success = signedDelivery(f.token);
    const first = await inbox.receive(success);

    if (first.kind !== "stored") {
      throw new Error("Expected first delivery to be stored");
    }

    events.push(first.eventId);

    // Same event token but different signed business facts.
    const failure = signedDelivery(f.token, "payment.failed");
    const conflict = await inbox.receive(failure);

    expect(conflict.kind).toBe("conflict");

    if (conflict.kind === "blocked") {
      throw new Error("Unexpected blocked event");
    }

    expect(conflict.eventId).toBe(first.eventId);

    const stored = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: first.eventId },
    });

    expect(stored.reviewRequired).toBe(true);
    expect(stored.reviewReason).toBe("EVENT_ID_CONFLICT");
    expect(stored.deliveryCount).toBe(2);

    expect(await inbox.process(first.eventId))
      .toEqual({ kind: "review_required" });

    const order = await db.order.findUniqueOrThrow({
      where: { id: f.order.id },
    });

    const payment = await db.payment.findUniqueOrThrow({
      where: { id: f.paymentId },
    });

    expect(order.paymentStatus).toBe("PENDING");
    expect(payment.status).toBe("PENDING");
  });
  it("handles concurrent duplicate webhook deliveries", async () => {
    const f = await fixture();
    const delivery = signedDelivery(f.token);

    const initial = await Promise.all(
      Array.from({ length: 4 }, () => inbox.receive(delivery))
    );

    const accepted: Array<{ kind: "stored" | "duplicate" | "quarantined" | "conflict"; eventId: string }> = [];

    for (let result of initial) {
      for (
        let retry = 0;
        result.kind === "blocked" && result.code === "BUSY" && retry < 5;
        retry++
      ) {
        await new Promise(resolve => setTimeout(resolve, 50 * (retry + 1)));
        result = await inbox.receive(delivery);
      }

      if (result.kind === "blocked") {
        throw new Error("Delivery remained blocked: " + result.code);
      }

      accepted.push(result);
    }

    expect(accepted.filter(r => r.kind === "stored")).toHaveLength(1);
    expect(accepted.filter(r => r.kind === "duplicate")).toHaveLength(3);

    const eventId = accepted[0].eventId;
    events.push(eventId);

    expect(accepted.every(r => r.eventId === eventId)).toBe(true);

    const event = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: eventId },
    });

    expect(event.deliveryCount).toBe(4);

    expect(await inbox.process(eventId)).toEqual({ kind: "settled" });

    const evidence = await db.paymentEvidence.findMany({
      where: {
        paymentId: f.paymentId,
        source: "WEBHOOK",
        decision: "SETTLED",
      },
    });

    expect(evidence).toHaveLength(1);
  });

  it("preserves replay protection across database reconnection", async () => {
    const f = await fixture();
    const delivery = signedDelivery(f.token);

    const first = await inbox.receive(delivery);

    if (first.kind !== "stored") {
      throw new Error("Expected stored webhook");
    }

    events.push(first.eventId);

    const { PrismaClient } = await import("../../generated/sqlite-client");

    const reopenedDb = new PrismaClient({
      datasources: {
        db: { url: process.env.DATABASE_URL },
      },
    });

    const reopenedVault = createPaymentPayloadVault(
      "integration",
      new Map([
        ["integration", new Uint8Array(vaultKey)],
      ])
    );

    try {
      const restartedInbox = createPaymentWebhookService(
        reopenedDb as unknown as PaymentPersistence,
        reopenedVault,
        { reconcileDelayMs: 60_000 }
      );

      expect(await restartedInbox.process(first.eventId))
        .toEqual({ kind: "settled" });

      const replay = await restartedInbox.receive(delivery);

      expect(replay.kind).toBe("duplicate");

      if (replay.kind === "blocked") {
        throw new Error("Unexpected blocked replay");
      }

      expect(replay.eventId).toBe(first.eventId);

      expect(await restartedInbox.process(first.eventId))
        .toEqual({ kind: "duplicate" });

      const evidence = await reopenedDb.paymentEvidence.findMany({
        where: {
          paymentId: f.paymentId,
          source: "WEBHOOK",
          decision: "SETTLED",
        },
      });

      expect(evidence).toHaveLength(1);
    } finally {
      await reopenedDb.$disconnect();
    }
  });
  it.each([
    "merchant",
    "tracker",
    "amount",
    "currency",
  ] as const)(
    "rejects correctly signed webhook with invalid %s",
    async (field) => {
      const f = await fixture();
      const original = signedDelivery(f.token);

      const payload = JSON.parse(
        Buffer.from(original.body).toString("utf8")
      ) as {
        merchant_api_key: string;
        data: {
          tracker: string;
          state: string;
          amount: number;
          currency: string;
        };
      };

      switch (field) {
        case "merchant":
          payload.merchant_api_key = "different-merchant";
          break;

        case "tracker":
          payload.data.tracker = "UNKNOWN_TRACKER_NOT_IN_DATABASE";
          break;

        case "amount":
          payload.data.amount = 100001;
          break;

        case "currency":
          payload.data.currency = "USD";
          break;
      }

      const modifiedBody = Buffer.from(JSON.stringify(payload));

      // Correctly sign the modified payload with the
      // synthetic sandbox test secret.
      // This isolates identity/financial validation
      // from ordinary signature verification.
      const validSignature = createHmac(
        "sha512",
        process.env.SAFEPAY_WEBHOOK_SECRET!
      )
        .update(modifiedBody)
        .digest("hex");

      const invalidDelivery: VerificationInput = {
        ...original,
        body: modifiedBody,
        headers: {
          "x-sfpy-signature": validSignature,
        },
      };

      const received = await inbox.receive(invalidDelivery);

      expect(received.kind).toBe("quarantined");

      if (received.kind === "blocked") {
        throw new Error("Unexpected blocked request");
      }

      events.push(received.eventId);

      const stored = await db.paymentWebhookEvent.findUniqueOrThrow({
        where: { id: received.eventId },
      });

      expect(stored.processingStatus).toBe("QUARANTINED");
      expect(stored.reviewRequired).toBe(true);
      expect(stored.paymentId).toBeNull();

      const processed = await inbox.process(received.eventId);

      expect(processed).toEqual({
        kind: "review_required",
      });

      const order = await db.order.findUniqueOrThrow({
        where: { id: f.order.id },
      });

      const payment = await db.payment.findUniqueOrThrow({
        where: { id: f.paymentId },
      });

      expect(order.status).toBe("PENDING");
      expect(order.paymentStatus).toBe("PENDING");
      expect(order.acceptedPaymentId).toBeNull();

      expect(payment.status).toBe("PENDING");

      const settledEvidenceCount = await db.paymentEvidence.count({
        where: {
          paymentId: f.paymentId,
          decision: "SETTLED",
        },
      });

      expect(settledEvidenceCount).toBe(0);
    }
  );
  it("rediscovers a pending reconciliation after reconnecting", async () => {
    const f = await fixture();

    const now = new Date();
    const retryAt = new Date(now.getTime() + 60_000);

    // Model a previously failed provider lookup whose
    // retry schedule has been durably persisted.
    await db.payment.update({
      where: { id: f.paymentId },
      data: {
        status: "PENDING",
        reconcileStatus: "UNCERTAIN",
        reconcileAttempts: 1,
        lastReconcileAt: now,
        nextReconcileAt: retryAt,
      },
    });

    // Create a completely new Prisma client to simulate
    // recovery using a new application database connection.
    const { PrismaClient } = await import("../../generated/sqlite-client");

    const reopenedDb = new PrismaClient({
      datasources: {
        db: { url: process.env.DATABASE_URL },
      },
    });

    let currentTime = new Date(retryAt.getTime() - 1);

    try {
      const restartedReconciliation =
        createPaymentReconciliationService(
          reopenedDb as unknown as PaymentPersistence,
          inbox,
          () => currentTime
        );

      // Pending payment must NOT be selected before its deadline.
      const early = await restartedReconciliation.due(100);

      expect(
        early.some(payment => payment.id === f.paymentId)
      ).toBe(false);

      // Advance past the persisted retry deadline.
      currentTime = new Date(retryAt.getTime() + 1000);

      const recovered = await restartedReconciliation.due(100);

      expect(
        recovered.some(payment => payment.id === f.paymentId)
      ).toBe(true);

      // Confirm that the retry information survived reconnecting.
      const payment = await reopenedDb.payment.findUniqueOrThrow({
        where: { id: f.paymentId },
      });

      expect(payment.status).toBe("PENDING");
      expect(payment.reconcileStatus).toBe("UNCERTAIN");
      expect(payment.reconcileAttempts).toBe(1);
      expect(payment.nextReconcileAt).toEqual(retryAt);
    } finally {
      await reopenedDb.$disconnect();
    }
  });
  function signedFinancialNotice(
    tracker: string,
    type: "payment.refunded" | "authorization.reversed" | "void.succeeded",
  ): VerificationInput {
    const stamp = { seconds: 1698758038, nanos: 682810001 };

    const data = type === "payment.refunded"
      ? {
          tracker,
          state: "TRACKER_PARTIAL_REFUND",
          refund_amount: 1000,
          balance: 99000,
          currency: "PKR",
          refunded_at: stamp,
        }
      : type === "authorization.reversed"
      ? {
          tracker,
          state: "TRACKER_REVERSED",
          reversed_authorization_id: "synthetic_auth",
          reversed_at: stamp,
        }
      : {
          tracker,
          state: "TRACKER_VOIDED",
          void_type: "CAPTURE",
          voided_charge_id: "synthetic_charge",
          voided_at: stamp,
        };

    const body = Buffer.from(JSON.stringify({
      token: "evt_" + randomUUID(),
      version: "2.0.0",
      merchant_api_key: "synthetic-public",
      type,
      data,
      created_at: stamp,
    }));

    return {
      provider: "SAFEPAY",
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
      channel: "WEBHOOK",
      body,
      headers: {
        "x-sfpy-signature": createHmac(
          "sha512",
          "synthetic-webhook-secret-0123456789abcdef"
        ).update(body).digest("hex"),
      },
    };
  }

  it("preserves captured payment after authenticated refund redelivery", async () => {
    const f = await fixture();

    // Establish a verified paid payment first.
    const capture = await inbox.receive(signedDelivery(f.token));

    expect(capture.kind).toBe("stored");
    if (!("eventId" in capture)) throw new Error("Missing capture event");

    events.push(capture.eventId);
    expect(await inbox.process(capture.eventId)).toEqual({
      kind: "settled",
    });

    // Receive an authentic refund notification.
    const notice = signedFinancialNotice(f.token, "payment.refunded");

    const first = await inbox.receive(notice);

    expect(first.kind).toBe("stored");
    if (!("eventId" in first)) throw new Error("Missing refund event");

    events.push(first.eventId);

    expect(await inbox.process(first.eventId)).toEqual({
      kind: "review_required",
    });

    // Identical provider redelivery must not duplicate effects.
    const duplicate = await inbox.receive(notice);

    expect(duplicate).toMatchObject({
      kind: "duplicate",
      eventId: first.eventId,
    });

    expect(await inbox.process(first.eventId)).toEqual({
      kind: "duplicate",
    });

    const order = await db.order.findUniqueOrThrow({
      where: { id: f.order.id },
      include: {
        payments: true,
        items: {
          include: { inventoryReservation: true },
        },
      },
    });

    const payment = order.payments[0];

    // Original capture and order history remain intact.
    expect(order.status).toBe("CONFIRMED");
    expect(order.paymentStatus).toBe("PAID");
    expect(order.paymentReviewStatus).toBe("REQUIRED");

    expect(payment.status).toBe("PAID");
    expect(payment.capturedAmountMinor).toBe(BigInt(100000));
    expect(payment.refundedAmountMinor).toBeNull();
    expect(payment.reconcileStatus).toBe("REVIEW_REQUIRED");

    expect(order.items[0].inventoryReservation?.state)
      .toBe("CONSUMED");

    // Exactly one financial audit record for this refund event.
    const evidence = await db.paymentEvidence.findMany({
      where: { sourceWebhookEventId: first.eventId },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      decision: "REVIEW_REQUIRED",
      reasonCode: "REFUND_REQUIRES_REVIEW",
      observedRefundedMinor: BigInt(1000),
    });

    const inboxEvent = await db.paymentWebhookEvent.findUniqueOrThrow({
      where: { id: first.eventId },
    });

    expect(inboxEvent.deliveryCount).toBe(2);
  });

  it.each([
    "authorization.reversed",
    "void.succeeded",
  ] as const)(
    "preserves captured funds after authenticated %s notification",
    async type => {
      const f = await fixture();

      const capture = await inbox.receive(signedDelivery(f.token));

      expect(capture.kind).toBe("stored");
      if (!("eventId" in capture)) throw new Error("Missing capture event");

      events.push(capture.eventId);

      expect(await inbox.process(capture.eventId)).toEqual({
        kind: "settled",
      });

      const notice = await inbox.receive(
        signedFinancialNotice(f.token, type)
      );

      expect(notice.kind).toBe("stored");
      if (!("eventId" in notice)) throw new Error("Missing notice event");

      events.push(notice.eventId);

      expect(await inbox.process(notice.eventId)).toEqual({
        kind: "review_required",
      });

      const order = await db.order.findUniqueOrThrow({
        where: { id: f.order.id },
        include: {
          payments: true,
          items: {
            include: { inventoryReservation: true },
          },
        },
      });

      expect(order.status).toBe("CONFIRMED");
      expect(order.paymentStatus).toBe("PAID");
      expect(order.paymentReviewStatus).toBe("REQUIRED");

      expect(order.payments[0].capturedAmountMinor)
        .toBe(BigInt(100000));

      expect(order.payments[0].refundedAmountMinor)
        .toBeNull();

      expect(order.payments[0].reconcileStatus)
        .toBe("REVIEW_REQUIRED");

      expect(order.items[0].inventoryReservation?.state)
        .toBe("CONSUMED");

      const evidence = await db.paymentEvidence.findMany({
        where: { sourceWebhookEventId: notice.eventId },
      });

      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        decision: "REVIEW_REQUIRED",
        reasonCode: "VERIFIER_REQUIRES_REVIEW",
      });
    }
  );
  it.each([
    "payment.refunded",
    "authorization.reversed",
    "void.succeeded",
  ] as const)(
    "blocks fulfillment after authenticated financial notices: %s",
    async type => {
      // Control: a normal verified, paid order can advance.
      const normal = await fixture();

      const normalCapture = await inbox.receive(
        signedDelivery(normal.token)
      );

      if (!("eventId" in normalCapture)) {
        throw new Error("Missing normal capture event");
      }

      events.push(normalCapture.eventId);

      expect(await inbox.process(normalCapture.eventId)).toEqual({
        kind: "settled",
      });

      const allowed = await adminUpdateOrderStatus(
        normal.order.id,
        "PROCESSING"
      );

      expect(allowed).toEqual({ ok: true });

      // Subject: another verified paid order receives a
      // signed refund, reversal, or void notification.
      const f = await fixture();

      const capture = await inbox.receive(
        signedDelivery(f.token)
      );

      if (!("eventId" in capture)) {
        throw new Error("Missing capture event");
      }

      events.push(capture.eventId);

      expect(await inbox.process(capture.eventId)).toEqual({
        kind: "settled",
      });

      const notice = await inbox.receive(
        signedFinancialNotice(f.token, type)
      );

      if (!("eventId" in notice)) {
        throw new Error("Missing financial notice");
      }

      events.push(notice.eventId);

      expect(await inbox.process(notice.eventId)).toEqual({
        kind: "review_required",
      });

      const before = await db.order.findUniqueOrThrow({
        where: { id: f.order.id },
      });

      expect(before).toMatchObject({
        status: "CONFIRMED",
        paymentStatus: "PAID",
        paymentReviewStatus: "REQUIRED",
      });

      // The very same transition must now be refused.
      const blocked = await adminUpdateOrderStatus(
        f.order.id,
        "PROCESSING"
      );

      expect(blocked.ok).toBe(false);

      const after = await db.order.findUniqueOrThrow({
        where: { id: f.order.id },
        include: {
          payments: true,
          items: {
            include: { inventoryReservation: true },
          },
        },
      });

      // The rejected operation must not modify the order.
      expect(after.status).toBe("CONFIRMED");
      expect(after.version).toBe(before.version);
      expect(after.paymentReviewStatus).toBe("REQUIRED");

      // Financial history and inventory remain intact.
      expect(after.payments[0].status).toBe("PAID");
      expect(after.payments[0].capturedAmountMinor)
        .toBe(BigInt(100000));

      expect(after.payments[0].refundedAmountMinor)
        .toBeNull();

      expect(after.items[0].inventoryReservation?.state)
        .toBe("CONSUMED");
    }
  );
});







