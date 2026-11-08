import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import { bindCheckoutOwner } from "@/services/safepay-attempt.store";
import { trackerIdentity, type VerificationInput } from "@/lib/payments/evidence-contract";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import type { PaymentPersistence } from "@/services/payment-settlement.service";

// End-to-end sandbox verification path: documented signed webhook → HMAC-SHA512
// authentication (real registry, no mock) → tracker resolution → durable inbox →
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

function signedDelivery(token: string, type = "payment.succeeded"): VerificationInput {
  const body = JSON.stringify({ type, data: {
    tracker: { token, state: type === "payment.succeeded" ? "TRACKER_ENDED" : "TRACKER_STARTED",
      purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
  } });
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
});
