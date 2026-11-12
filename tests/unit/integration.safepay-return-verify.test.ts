import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/sqlite-client";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import { bindCheckoutOwner } from "@/services/safepay-attempt.store";
import { loadSafepayConfig } from "@/lib/safepay/config";
import { createSafepayProvider, type HttpTransport } from "@/lib/safepay/provider";
import { createSafepayReturnService } from "@/services/safepay-return.service";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentVerificationService, type PaymentDatabase } from "@/services/payment-verification.service";
import { createPaymentPayloadVault, type PaymentPayloadVault } from "@/lib/payments/payload-vault";
import { loadPaymentPayloadVaultKeys } from "@/lib/payments/vault-env";
import { updateManagedOrderStatus } from "@/services/safepay-reservations.service";

// Return-path verification loop, proven against real disposable persistence with a
// mocked provider transport (no real network, no real money):
//   customer returns → read-only snapshot says PENDING → ONE targeted reporter lookup
//   (TRACKER_ENDED) → authenticated evidence → settlement → order PAID → reservations
//   consumed → the admin fulfilment gate that previously answered 409 now allows
//   processing. Transport failures and pending providers only ever schedule retries.

assertDisposableTestDatabase();

process.env.SAFEPAY_ENVIRONMENT = "sandbox";
process.env.SAFEPAY_ENTRY_MODE = "flex";
process.env.SAFEPAY_MERCHANT_API_KEY = "synthetic-public";
process.env.SAFEPAY_SECRET_KEY = "synthetic-secret";
process.env.SAFEPAY_RETURN_STATE_SECRET = "synthetic-independent-return-key-at-least-32-bytes";
process.env.SAFEPAY_MERCHANT_ACCOUNT_REF = "synthetic-account";
process.env.SAFEPAY_SITE_ORIGIN = "https://shop.example.invalid";
process.env.PAYMENT_PAYLOAD_KEY = Buffer.alloc(32, 7).toString("base64");

const config = loadSafepayConfig();

// The verification registry resolves tracker identity through @/lib/db; point that
// import at the disposable SQLite database for this suite.
vi.mock("@/lib/db", async () => {
  const { PrismaClient: SqliteClient } = await import("../../generated/sqlite-client");
  return { db: new SqliteClient({ datasources: { db: { url: process.env.DATABASE_URL } } }) };
});

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const orders: string[] = [], products: string[] = [], categories: string[] = [], users: string[] = [], coupons: string[] = [];
const serialize = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);

async function fixture(options: { coupon?: boolean; state?: string } = {}) {
  const now = new Date();
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid", emailVerified: now } });
  users.push(user.id);
  const binding = bindCheckoutOwner({ kind: "USER", userId: user.id });
  const category = await db.category.create({ data: { name: "Return-verify synthetic " + randomUUID(), slug: randomUUID() } });
  categories.push(category.id);
  const product = await db.product.create({ data: {
    name: "Synthetic return product", slug: randomUUID(), categoryId: category.id, price: 1000,
    inventory: { create: { quantity: 4 } },
  }, include: { inventory: true } });
  products.push(product.id);
  const total = options.coupon ? 900 : 1000;
  const trackerToken = "synthetic-" + randomUUID();
  const identity = createHash("sha256").update(JSON.stringify(
    ["SAFEPAY", config.environment, config.merchantAccountRef, trackerToken])).digest("hex");
  // Model the real reserved flow: the hold already reduced sellable stock.
  await db.inventory.update({ where: { productId: product.id }, data: { quantity: { decrement: 1 } } });
  const order = await db.$transaction(async tx => {
    const order = await tx.order.create({ data: {
      reference: "SFP-" + randomUUID(), idempotencyKey: randomUUID(), isGuest: false,
      user: { connect: { id: user.id } },
      customerName: "Synthetic", customerEmail: "synthetic@example.invalid", customerPhone: "03000000000",
      shipFullName: "Synthetic", shipPhone: "03000000000", shipLine1: "Synthetic", shipCity: "Test", shipProvince: "Test",
      paymentMethod: "ONLINE", status: "PENDING", paymentStatus: "PENDING", paymentFlowVersion: 1,
      nextPaymentAttempt: 2, currency: "PKR", subtotal: 1000, discountTotal: options.coupon ? 100 : 0, total,
      paymentReviewStatus: "CLEAR",
      checkoutOwnerKind: binding.kind, checkoutOwnerHash: binding.hash, checkoutFingerprint: "a".repeat(64),
      checkoutAccessExpiresAt: new Date(now.getTime() + 600000), reservationExpiresAt: new Date(now.getTime() + 600000),
      items: { create: { productId: product.id, productName: product.name, productSlug: product.slug, quantity: 1, unitPrice: 1000, lineTotal: 1000 } },
      payments: { create: {
        provider: "SAFEPAY", amount: total, currency: "PKR", attemptNumber: 1, attemptState: "CHECKOUT_ISSUED",
        providerEnvironment: config.environment, merchantAccountRef: config.merchantAccountRef,
        expectedAmountMinor: BigInt(total * 100), trackerToken, trackerIdentityKey: identity,
        trackerBoundAt: now, creationStartedAt: now, providerState: "TRACKER_STARTED",
        providerStateObservedAt: now, reconcileStatus: "PENDING",
      } },
    }, include: { items: true, payments: true } });
    await tx.inventoryReservation.create({ data: {
      orderItemId: order.items[0].id, inventoryId: product.inventory!.id, quantity: 1,
    } });
    if (options.coupon) {
      const coupon = await tx.coupon.create({ data: {
        code: randomUUID(), type: "PERCENT", value: 10, maxUses: 5, reservedCount: 1,
      } });
      coupons.push(coupon.id);
      await tx.couponReservation.create({ data: { orderId: order.id, couponId: coupon.id } });
      await tx.order.update({ where: { id: order.id }, data: { couponCode: coupon.code } });
    }
    await tx.order.update({ where: { id: order.id }, data: { paymentOwnerOrderId: order.id, activePaymentId: order.payments[0].id } });
    return order;
  });
  orders.push(order.id);
  return { order, payment: order.payments[0], owner: binding, trackerToken, product, total, state: options.state ?? "TRACKER_ENDED" };
}

function reporterTransport(state: string, amountMinor: number): HttpTransport {
  return async (url) => {
    const token = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    // Documented Fetch Tracker response (concepts/fetch-tracker): tracker fields sit
    // directly under `data` — no "tracker" wrapper, no status.errors envelope.
    return new Response(JSON.stringify({
      ok: true,
      data: {
        token, environment: config.environment, state,
        intent: "CYBERSOURCE", mode: "payment", entry_mode: "flex",
        purchase_totals: { quote_amount: { currency: "PKR", amount: amountMinor } },
      },
    }), { status: 200 });
  };
}

function buildStack(http: HttpTransport) {
  const vaultKeys = loadPaymentPayloadVaultKeys();
  if (!vaultKeys) throw new Error("vault keys unavailable");
  const database = db as unknown as PaymentDatabase;
  const vault: PaymentPayloadVault = createPaymentPayloadVault(vaultKeys.activeKeyId, vaultKeys.keyRing);
  const inbox = createPaymentWebhookService(db as never, vault, { reconcileDelayMs: 60_000 });
  const reconciliation = createPaymentReconciliationService(db as never, inbox);
  const verification = createPaymentVerificationService({
    database, config,
    provider: createSafepayProvider(config, http),
    reconciliation,
  });
  return { inbox, reconciliation, verification };
}

async function readReturnSnapshot(trackerToken: string, owner: ReturnType<typeof bindCheckoutOwner>) {
  const readReturn = createSafepayReturnService(config, async input => {
    if (input.mode !== "tracker") return null;
    return db.payment.findFirst({
      where: {
        provider: "SAFEPAY", providerEnvironment: config.environment,
        merchantAccountRef: config.merchantAccountRef, trackerToken: input.trackerToken,
        order: { is: { userId: owner.userId, isGuest: false, checkoutOwnerKind: owner.kind,
          checkoutOwnerHash: owner.hash, paymentFlowVersion: 1, paymentMethod: "ONLINE" } },
      },
      select: {
        id: true, status: true, attemptState: true, reconcileStatus: true, paidVerifiedAt: true,
        order: { select: { reference: true, paymentStatus: true, acceptedPaymentId: true } },
      },
    }).then(p => p ? {
      paymentId: p.id, paymentStatus: p.status, attemptState: p.attemptState,
      reconcileStatus: p.reconcileStatus, paidVerifiedAt: p.paidVerifiedAt,
      orderPaymentStatus: p.order.paymentStatus, acceptedPaymentId: p.order.acceptedPaymentId,
      reference: p.order.reference,
    } : null);
  });
  return readReturn({ tracker: trackerToken, owner: { kind: "USER", userId: owner.userId } });
}

afterAll(async () => {
  // Evidence rows restrict-delete their source/final webhook events: remove them first.
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.paymentWebhookEvent.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await db.couponReservation.deleteMany({ where: { orderId: { in: orders } } });
  await db.order.updateMany({ where: { id: { in: orders } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orders } } });
  await db.product.deleteMany({ where: { id: { in: products } } });
  await db.category.deleteMany({ where: { id: { in: categories } } });
  await db.coupon.deleteMany({ where: { id: { in: coupons } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("Return-path payment verification and settlement (isolated persistence)", () => {
  it("settles a paid tracker end-to-end and unlocks the admin fulfilment gate", async () => {
    const f = await fixture({ coupon: true });
    const { verification } = buildStack(reporterTransport("TRACKER_ENDED", f.total * 100));

    // 1. Customer returns: the read-only page correctly reports pending…
    const before = await readReturnSnapshot(f.trackerToken, f.owner);
    expect(before).toMatchObject({ kind: "pending", reference: f.order.reference });
    if (before.kind !== "pending") throw new Error("expected pending");
    expect(serialize(before)).not.toContain(f.trackerToken);

    // 2. …the page then triggers ONE targeted server-side verification.
    const outcome = await verification.verifyPaymentNow(before.paymentId);
    expect(outcome).toEqual({ kind: "settled" });

    // 3. Re-read now reports success — exactly what the customer sees.
    const after = await readReturnSnapshot(f.trackerToken, f.owner);
    expect(after).toMatchObject({ kind: "success", reference: f.order.reference });

    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
    expect(payment).toMatchObject({ status: "PAID", attemptState: "SETTLED", reconcileStatus: "VERIFIED" });
    expect(payment.paidVerifiedAt).not.toBeNull();
    expect(payment.capturedAmountMinor).toBe(BigInt(f.total * 100));

    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(order).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID", paymentReviewStatus: "CLEAR" });
    expect(order.acceptedPaymentId).toBe(f.payment.id);

    // 4. Reservations consumed exactly once; coupon committed; no stock write at settlement.
    const hold = await db.inventoryReservation.findUniqueOrThrow({ where: { orderItemId: f.order.items[0].id } });
    expect(hold).toMatchObject({ state: "CONSUMED", quantity: 1 });
    expect((await db.inventory.findUniqueOrThrow({ where: { productId: f.product.id } })).quantity).toBe(3);
    const coupon = await db.coupon.findFirstOrThrow({ where: { id: { in: coupons }, reservations: { some: { orderId: f.order.id } } } });
    expect(coupon).toMatchObject({ usedCount: 1, reservedCount: 0 });

    // 5. The previously-409 admin fulfilment gate now allows processing (settlement
    // already confirmed the order; the admin moves it forward through the state machine).
    const fulfil = await db.$transaction(tx => updateManagedOrderStatus(tx as never, f.order.id, "PROCESSING", new Date()));
    expect(fulfil).toEqual({ ok: true });
  });

  it("never settles twice: a settled payment is no longer eligible for verification", async () => {
    const f = await fixture();
    const { verification } = buildStack(reporterTransport("TRACKER_ENDED", f.total * 100));
    expect(await verification.verifyPaymentNow(f.payment.id)).toEqual({ kind: "settled" });
    expect(await verification.verifyPaymentNow(f.payment.id)).toEqual({ kind: "skipped", code: "NOT_ELIGIBLE" });
    const items = await db.inventoryReservation.findMany({ where: { orderItem: { orderId: f.order.id } } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "CONSUMED" });
    expect((await db.inventory.findUniqueOrThrow({ where: { productId: f.product.id } })).quantity).toBe(3);
  });

  it("keeps a pending provider state pending and schedules exactly one retry", async () => {
    const f = await fixture();
    const { verification } = buildStack(reporterTransport("TRACKER_STARTED", f.total * 100));
    const outcome = await verification.verifyPaymentNow(f.payment.id);
    expect(outcome).toEqual({ kind: "recorded" });
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
    expect(payment).toMatchObject({ status: "PENDING", reconcileStatus: "PENDING", reconcileAttempts: 1 });
    expect(payment.nextReconcileAt).not.toBeNull();
    expect(payment.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now());
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(order).toMatchObject({ status: "PENDING", paymentStatus: "PENDING" });
    const hold = await db.inventoryReservation.findUniqueOrThrow({ where: { orderItemId: f.order.items[0].id } });
    expect(hold.state).toBe("HELD");
  });

  it("schedules capped backoff on provider transport failure without inventing finality", async () => {
    const f = await fixture();
    const failing: HttpTransport = async () => new Response("synthetic outage", { status: 503 });
    const { verification } = buildStack(failing);
    const outcome = await verification.verifyPaymentNow(f.payment.id);
    expect(outcome).toEqual({ kind: "provider_fetch_failed", code: "HTTP_ERROR" });
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
    expect(payment).toMatchObject({ status: "PENDING", reconcileStatus: "PENDING", lastErrorCode: "HTTP_ERROR", reconcileAttempts: 1 });
    expect(payment.nextReconcileAt!.getTime()).toBeGreaterThan(Date.now());
    // The refresh-spam guard suppresses immediate repeat lookups.
    expect(await verification.verifyPaymentNow(f.payment.id)).toEqual({ kind: "skipped", code: "BACKOFF" });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(order).toMatchObject({ status: "PENDING", paymentStatus: "PENDING", paymentReviewStatus: "CLEAR" });
  });
});
