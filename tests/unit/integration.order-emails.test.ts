// Integration tests — order/payment/refund customer emails (Phase 3,
// Chunk 7-final — D14/H-14) against a throwaway SQLite database.
// Run with: npm run test:db
//
// The outbox worker and the payload parsing are real; only the mail
// senders are mocked (they capture what would have been sent) and the
// payment verifier is simulated, exactly like the settlement/refund
// suites. Every assertion is scoped to this file's own unique emails
// because the disposable database is shared across integration suites
// in a run — other suites' leftover outbox rows may be delivered by
// this file's sweeps, so `sent.*` assertions always filter by the
// test's own order reference.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const simulated = vi.hoisted(() => ({ enabled: true,
  observations: new Map<string, { auth: string | null; observation: unknown }>() }));
vi.mock("@/lib/payments/verification-registry", () => ({ PAYMENT_PROVIDER_VERIFICATION_ENABLED: false,
  approvedPaymentVerifier: (input: { provider: string; channel: string; environment: string; merchantAccountRef: string }) =>
    !simulated.enabled ? null : { provider: input.provider, channel: input.channel, environment: input.environment,
      merchantAccountRef: input.merchantAccountRef, merchantIdentity: "SIMULATED_MERCHANT", contractVersion: "SIMULATED_ONLY_V1",
      retainedHeaderNames: ["x-simulated-proof"], verify: async (request: { body: Uint8Array; headers: Record<string, string> }) => {
        const row = simulated.observations.get(new TextDecoder().decode(request.body));
        return row && (row.auth === null || request.headers["x-simulated-proof"] === row.auth) ?
          { kind: "authenticated", observation: row.observation } : { kind: "rejected" };
      } },
}));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return { db: new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: ["error"] }) };
});

// Captured mail sends (senders mocked; enqueueing, dedup, payload
// parsing and the worker sweep are all real).
const sent = vi.hoisted(() => ({
  confirmed: [] as Array<Record<string, unknown>>,
  status: [] as Array<Record<string, unknown>>,
  cancelled: [] as Array<Record<string, unknown>>,
  paymentSucceeded: [] as Array<Record<string, unknown>>,
  paymentFailed: [] as Array<Record<string, unknown>>,
  refundSucceeded: [] as Array<Record<string, unknown>>,
  verification: [] as Array<{ email: string; token: string; callbackUrl?: string }>,
}));
vi.mock("@/services/email.service", () => ({
  EmailDeliveryNotConfiguredError: class EmailDeliveryNotConfiguredError extends Error {},
  isEmailDeliveryConfigured: () => true,
  classifyEmailSendError: () => ({ kind: "transient", permanent: false, authFailure: false, reason: "Transient email delivery failure — will retry with backoff." }),
  resetEmailTransporter: vi.fn(),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendAlertEmail: vi.fn(async () => {}),
  sendVerificationEmail: vi.fn(async (input: { email: string; token: string; callbackUrl?: string }) => { sent.verification.push(input); }),
  sendOrderConfirmedEmail: vi.fn(async (input: Record<string, unknown>) => { sent.confirmed.push(input); }),
  sendOrderStatusEmail: vi.fn(async (input: Record<string, unknown>) => { sent.status.push(input); }),
  sendOrderCancelledEmail: vi.fn(async (input: Record<string, unknown>) => { sent.cancelled.push(input); }),
  sendOrderPaymentSucceededEmail: vi.fn(async (input: Record<string, unknown>) => { sent.paymentSucceeded.push(input); }),
  sendOrderPaymentFailedEmail: vi.fn(async (input: Record<string, unknown>) => { sent.paymentFailed.push(input); }),
  sendOrderRefundSucceededEmail: vi.fn(async (input: Record<string, unknown>) => { sent.refundSucceeded.push(input); }),
}));

import { db } from "@/lib/db";
import { placeOrder } from "@/services/checkout.service";
import { adminUpdateOrderStatus, customerCancelOrder } from "@/services/orders.service";
import { createSafepayPendingOrderService } from "@/services/safepay-pending-order.service";
import { createSafepayReservationService } from "@/services/safepay-reservations.service";
import { bindCheckoutOwner, type PaymentDatabase, type TrustedCheckoutOwner } from "@/services/safepay-attempt.store";
import { createPaymentSettlementService, type PaymentPersistence } from "@/services/payment-settlement.service";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentRefundService, type RefundSubmissionOutcome } from "@/services/payment-refund.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { trackerIdentity, type PaymentObservation, type VerificationInput } from "@/lib/payments/evidence-contract";
import type { SafepayProvider } from "@/lib/safepay/provider";
import { DEFAULT_SETTINGS } from "@/services/settings.service";
import * as settingsService from "@/services/settings.service";
import { deliverPendingOutboxEmails, emailOutboxOrderReference, enqueueVerificationEmail, getEmailOutboxEntry, listEmailOutboxEntries, retryEmailOutboxEntry } from "@/services/email-outbox.service";
import { sendOrderConfirmedEmail } from "@/services/email.service";
import { enqueueOrderConfirmedEmail, enqueueOrderStatusEmail } from "@/services/order-notification.service";
import { resendVerificationEmail } from "@/services/email-verification.service";
import { resolveSafepayCancel } from "@/services/safepay-cancel.service";
import { loadSafepayConfig } from "@/lib/safepay/config";
import { signReturnState } from "@/lib/safepay/redirect";
import type { PlaceOrderInput } from "@/lib/validation";

assertDisposableTestDatabase();
const database = db as unknown as PaymentPersistence;
const baseTime = new Date("2026-11-05T20:00:00.000Z"); let time = new Date(baseTime);
const clock = () => new Date(time);
const options = { now: clock, reconcileDelayMs: 60_000 };
const key = randomBytes(32), vault = createPaymentPayloadVault("synthetic-key", new Map([["synthetic-key", key]]));
const inbox = createPaymentWebhookService(database, vault, options);
const settlement = createPaymentSettlementService(database, options);
const reconciliation = createPaymentReconciliationService(database, inbox, clock);
const settings = { ...DEFAULT_SETTINGS };
const submittedViaProvider: Array<{ trackerToken: string; amountMinor: bigint }> = [];
type ProviderRefundOutcome = Awaited<ReturnType<SafepayProvider["submitRefund"]>>;
function providerStub(outcomes: ProviderRefundOutcome[] = []): Pick<SafepayProvider, "submitRefund"> {
  let call = 0;
  return { submitRefund: vi.fn(async (input: { trackerToken: string; amountMinor: bigint }) => {
    submittedViaProvider.push(input);
    const outcome = outcomes[Math.min(call, outcomes.length - 1)];
    call += 1;
    return outcome ?? { kind: "submitted" as const };
  }) };
}
const refundOptions = { now: clock, environment: "sandbox", merchantAccountRef: "synthetic-account",
  pollDelayMs: 1_000, maxConfirmationAttempts: 2, submitGraceMs: 120_000,
  reversalWindowMs: 0, cardRefundWindowMs: Number.MAX_SAFE_INTEGER };
const refunds = createPaymentRefundService(database, providerStub(), refundOptions);
const reservations = createSafepayReservationService(database as unknown as PaymentDatabase, clock);
const cancelConfig = loadSafepayConfig({ SAFEPAY_ENVIRONMENT: "sandbox", SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public", SAFEPAY_SECRET_KEY: "synthetic-secret",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-independent-return-key-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account", SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid" });

// Tracked ids for afterAll cleanup.
const orderIds: string[] = [], productIds: string[] = [], categoryIds: string[] = [],
  cartIds: string[] = [], userIds: string[] = [], eventIds: string[] = [],
  refundIds: string[] = [], paymentIds: string[] = [], emails: string[] = [];

const codSettings = {
  ...DEFAULT_SETTINGS, cod_enabled: true, online_payment_enabled: true,
  delivery_fee_standard: 0, delivery_fee_express: 0, free_delivery_threshold: 0,
  gift_wrap_enabled: false, gift_wrap_charge: 0,
};
beforeAll(() => {
  vi.spyOn(settingsService, "getSettings").mockResolvedValue(codSettings);
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(settingsService, "getSettings").mockResolvedValue(codSettings);
  time = new Date(baseTime);
  simulated.enabled = true;
  submittedViaProvider.length = 0;
  sent.confirmed.length = 0; sent.status.length = 0; sent.cancelled.length = 0;
  sent.paymentSucceeded.length = 0; sent.paymentFailed.length = 0;
  sent.refundSucceeded.length = 0; sent.verification.length = 0;
});

function checkoutInput(method: "ONLINE" | "COD", email: string): PlaceOrderInput {
  return { idempotencyKey: randomUUID(), paymentMethod: method, deliveryMethod: "STANDARD",
    customer: { name: "Email Buyer", email, phone: "03001234567" },
    address: { fullName: "Email Buyer", phone: "03001234567", line1: "Email Street 1", city: "Lahore", province: "Punjab" } };
}

async function seedProduct(stock = 5) {
  const category = await db.category.create({ data: { name: "Email " + randomUUID(), slug: randomUUID() } });
  categoryIds.push(category.id);
  const product = await db.product.create({ data: { name: "Email item", slug: randomUUID(),
    categoryId: category.id, price: 1000, status: "PUBLISHED", inventory: { create: { quantity: stock } } } });
  productIds.push(product.id);
  return { category, product };
}

// A COD order placed through the real placeOrder path.
async function codOrder() {
  const email = randomUUID() + "@example.invalid"; emails.push(email);
  const user = await db.user.create({ data: { email } }); userIds.push(user.id);
  const { product } = await seedProduct();
  const cart = await db.cart.create({ data: { userId: user.id, items: { create: [{ productId: product.id, quantity: 1 }] } } });
  cartIds.push(cart.id);
  const input = checkoutInput("COD", email);
  const result = await placeOrder(input, user.id);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("COD placement failed: " + result.error);
  orderIds.push(result.orderId);
  return { user, email, product, input, orderId: result.orderId, reference: result.reference, total: 1000 };
}

// A Safepay pending order (ONLINE) with a bound tracker, optionally settled.
async function safepayFixture(opts: { settle?: boolean } = {}) {
  const email = randomUUID() + "@example.invalid"; emails.push(email);
  const { product } = await seedProduct();
  const user = await db.user.create({ data: { email } }); userIds.push(user.id);
  const owner = { kind: "USER" as const, userId: user.id };
  const cart = await db.cart.create({ data: { userId: user.id, items: { create: [{ productId: product.id, quantity: 2 }] } } });
  cartIds.push(cart.id);
  const run = createSafepayPendingOrderService({ database, getSettings: async () => settings,
    environment: "sandbox", merchantAccountRef: "synthetic-account", reservationTtlMs: 600_000, now: clock });
  const prepared = await run(checkoutInput("ONLINE", email), { cartId: cart.id, owner });
  if (prepared.kind !== "ready") throw new Error("Synthetic pending order failed: " + prepared.code);
  orderIds.push(prepared.orderId); paymentIds.push(prepared.paymentId);
  const token = "synthetic-tracker-" + randomUUID();
  await db.payment.update({ where: { id: prepared.paymentId }, data: { trackerToken: token,
    trackerIdentityKey: trackerIdentity({ provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account", trackerToken: token }),
    creationStartedAt: time, trackerBoundAt: time, attemptState: "CHECKOUT_ISSUED", reconcileStatus: "PENDING" } });
  const payment = await db.payment.findUniqueOrThrow({ where: { id: prepared.paymentId } });
  const observation: PaymentObservation = { provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    merchantIdentity: "SIMULATED_MERCHANT", observationId: randomUUID(), orderId: prepared.orderId, paymentId: prepared.paymentId,
    attemptNumber: 1, trackerToken: token, owner: bindCheckoutOwner(owner), currency: "PKR",
    amountMinor: payment.expectedAmountMinor!.toString(), kind: "CAPTURE_CONFIRMED",
    capturedMinor: payment.expectedAmountMinor!.toString(), refundMinor: "0", occurredAt: time.toISOString() };
  if (opts.settle !== false) {
    const settled = await processObservation(observation);
    if (settled.kind !== "settled") throw new Error("Synthetic capture failed: " + JSON.stringify(settled));
  }
  return { ...prepared, user, email, product, owner, token, payment, observation,
    capturedMinor: payment.expectedAmountMinor! };
}

// A managed PENDING order for the Safepay cancel page (no tracker bound).
async function cancelPageFixture() {
  const email = randomUUID() + "@example.invalid"; emails.push(email);
  const now = new Date();
  const user = await db.user.create({ data: { email, emailVerified: now } }); userIds.push(user.id);
  const owner: TrustedCheckoutOwner = { kind: "USER", userId: user.id };
  const binding = bindCheckoutOwner(owner);
  const { product } = await seedProduct(4);
  const order = await db.$transaction(async tx => {
    const created = await tx.order.create({ data: {
      reference: "SFP-" + randomUUID(), idempotencyKey: randomUUID(), isGuest: false,
      user: { connect: { id: user.id } },
      customerName: "Synthetic", customerEmail: email, customerPhone: "03000000000",
      shipFullName: "Synthetic", shipPhone: "03000000000", shipLine1: "Synthetic", shipCity: "Test", shipProvince: "Test",
      paymentMethod: "ONLINE", status: "PENDING", paymentStatus: "PENDING", paymentFlowVersion: 1,
      nextPaymentAttempt: 2, currency: "PKR", subtotal: 1000, discountTotal: 0, total: 1000,
      checkoutOwnerKind: binding.kind, checkoutOwnerHash: binding.hash, checkoutFingerprint: "a".repeat(64),
      checkoutAccessExpiresAt: new Date(now.getTime() + 600000), reservationExpiresAt: new Date(now.getTime() + 600000),
      items: { create: { productId: product.id, productName: product.name, productSlug: product.slug, quantity: 1, unitPrice: 1000, lineTotal: 1000 } },
      payments: { create: { provider: "SAFEPAY", amount: 1000, currency: "PKR", attemptNumber: 1,
        attemptState: "READY", providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account", expectedAmountMinor: BigInt(100000) } },
    }, include: { items: true, payments: true } });
    const inventoryId = (await tx.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).id;
    await tx.inventoryReservation.create({ data: { orderItemId: created.items[0].id, inventoryId, quantity: 1 } });
    await tx.inventory.update({ where: { id: inventoryId }, data: { quantity: 3 } });
    await tx.order.update({ where: { id: created.id }, data: { paymentOwnerOrderId: created.id, activePaymentId: created.payments[0].id } });
    return created;
  });
  orderIds.push(order.id); paymentIds.push(order.payments[0].id);
  const state = signReturnState(cancelConfig, { orderId: order.id, paymentId: order.payments[0].id,
    ownerHash: binding.hash, expiresAt: Date.now() + 600_000 });
  return { order, payment: order.payments[0], owner, state, email };
}

function authenticatedInput(observation: PaymentObservation, channel: "WEBHOOK" | "RECONCILIATION" = "WEBHOOK"): VerificationInput {
  const body = JSON.stringify({ syntheticObservation: randomUUID() }), auth = randomUUID();
  simulated.observations.set(body, { auth, observation });
  return { provider: observation.provider, environment: observation.environment, merchantAccountRef: observation.merchantAccountRef,
    channel, body: Buffer.from(body), headers: { "x-simulated-proof": auth } };
}
async function receive(observation: PaymentObservation, channel: "WEBHOOK" | "RECONCILIATION" = "WEBHOOK") {
  const input = authenticatedInput(observation, channel), result = await inbox.receive(input);
  if (!("eventId" in result)) throw new Error("Synthetic inbox failed");
  eventIds.push(result.eventId); return { ...result, input };
}
async function processObservation(observation: PaymentObservation, channel: "WEBHOOK" | "RECONCILIATION" = "WEBHOOK") {
  const received = await receive(observation, channel); return inbox.process(received.eventId);
}
function refundObservation(f: Awaited<ReturnType<typeof safepayFixture>>, refundMinor: string): PaymentObservation {
  return { provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    merchantIdentity: "SIMULATED_MERCHANT", observationId: randomUUID(), orderId: f.orderId, paymentId: f.paymentId,
    attemptNumber: 1, trackerToken: f.token, owner: bindCheckoutOwner(f.owner), currency: "PKR",
    amountMinor: "0", kind: "REFUND_CONFIRMED", capturedMinor: null, refundMinor,
    providerState: "TRACKER_PARTIAL_REFUND", occurredAt: time.toISOString() };
}
async function outboxRows(email: string, type?: string) {
  return db.emailOutbox.findMany({ where: { email, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });
}
function payloadOf(row: { payload: string | null }) { return JSON.parse(row.payload!); }
// Sweep until this email's rows are gone (the shared disposable DB may
// hold older rows from other suites; batch 50 keeps our row in range).
async function deliverAllFor(email: string) {
  for (let i = 0; i < 10; i++) {
    await deliverPendingOutboxEmails(50);
    if ((await outboxRows(email)).length === 0) return;
  }
  throw new Error("outbox rows for " + email + " did not drain");
}

afterAll(async () => {
  await db.emailOutbox.deleteMany({ where: { email: { in: emails } } });
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orderIds } } } });
  await db.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await db.paymentWebhookEvent.deleteMany({ where: { OR: [{ id: { in: eventIds } }, { payment: { orderId: { in: orderIds } } }] } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orderIds } } } });
  await db.order.updateMany({ where: { id: { in: orderIds } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.cart.deleteMany({ where: { id: { in: cartIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("order confirmation email (COD)", () => {
  it("enqueues exactly one ORDER_CONFIRMED row at COD placement", async () => {
    const f = await codOrder();
    const rows = await outboxRows(f.email, "ORDER_CONFIRMED");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
    expect(payloadOf(rows[0])).toMatchObject({
      orderId: f.orderId, reference: f.reference, customerName: "Email Buyer",
      total: 1000, paymentMethod: "COD",
    });
  });

  it("does not re-enqueue on an idempotency replay after delivery", async () => {
    const f = await codOrder();
    await deliverAllFor(f.email);
    expect(await outboxRows(f.email, "ORDER_CONFIRMED")).toHaveLength(0);
    const replay = await placeOrder(f.input, f.user.id);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.orderId).toBe(f.orderId);
    expect(await outboxRows(f.email, "ORDER_CONFIRMED")).toHaveLength(0);
  });

  it("an enqueue failure does not fail the order", async () => {
    const email = randomUUID() + "@example.invalid"; emails.push(email);
    const user = await db.user.create({ data: { email } }); userIds.push(user.id);
    const { product } = await seedProduct();
    const cart = await db.cart.create({ data: { userId: user.id, items: { create: [{ productId: product.id, quantity: 1 }] } } });
    cartIds.push(cart.id);
    const create = vi.spyOn(db.emailOutbox, "create").mockRejectedValueOnce(new Error("synthetic outbox outage"));
    const result = await placeOrder(checkoutInput("COD", email), user.id);
    create.mockRestore();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    orderIds.push(result.orderId);
    expect(await outboxRows(email)).toHaveLength(0);
  });
});

describe("order status emails", () => {
  it("enqueues one ORDER_STATUS row per admin transition, with carrier and tracking on SHIPPED", async () => {
    const f = await codOrder();
    await adminUpdateOrderStatus(f.orderId, "PROCESSING");
    await adminUpdateOrderStatus(f.orderId, "SHIPPED", undefined, { carrier: "TCS", trackingNumber: "TRK-123" });
    await adminUpdateOrderStatus(f.orderId, "DELIVERED");
    const rows = await outboxRows(f.email, "ORDER_STATUS");
    expect(rows).toHaveLength(3);
    expect(payloadOf(rows[0])).toMatchObject({ orderId: f.orderId, status: "PROCESSING" });
    expect(payloadOf(rows[1])).toMatchObject({ orderId: f.orderId, status: "SHIPPED", carrier: "TCS", trackingNumber: "TRK-123" });
    expect(payloadOf(rows[2])).toMatchObject({ orderId: f.orderId, status: "DELIVERED" });
  });

  it("does not duplicate when the same status is enqueued twice", async () => {
    const f = await codOrder();
    await enqueueOrderStatusEmail({ orderId: f.orderId, status: "PROCESSING" });
    await enqueueOrderStatusEmail({ orderId: f.orderId, status: "PROCESSING" });
    expect(await outboxRows(f.email, "ORDER_STATUS")).toHaveLength(1);
  });

  it("delivers the status email with the reference, status and carrier", async () => {
    const f = await codOrder();
    await adminUpdateOrderStatus(f.orderId, "PROCESSING");
    await adminUpdateOrderStatus(f.orderId, "SHIPPED", undefined, { carrier: "TCS", trackingNumber: "TRK-123" });
    await deliverAllFor(f.email);
    const delivered = sent.status.filter(s => s.reference === f.reference);
    expect(delivered).toHaveLength(2);
    expect(delivered.find(s => s.status === "SHIPPED")).toMatchObject({
      orderId: f.orderId, carrier: "TCS", trackingNumber: "TRK-123",
    });
  });
});

describe("cancellation emails", () => {
  it("enqueues exactly one ORDER_CANCELLED row for an admin cancel", async () => {
    const f = await codOrder();
    expect((await adminUpdateOrderStatus(f.orderId, "CANCELLED")).ok).toBe(true);
    const rows = await outboxRows(f.email, "ORDER_CANCELLED");
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0])).toMatchObject({ orderId: f.orderId, reference: f.reference });
  });

  it("enqueues exactly one ORDER_CANCELLED row for a customer cancel, and a second cancel does not re-notify", async () => {
    const f = await codOrder();
    expect((await customerCancelOrder(f.orderId, f.user.id)).ok).toBe(true);
    expect((await customerCancelOrder(f.orderId, f.user.id)).ok).toBe(true);
    expect(await outboxRows(f.email, "ORDER_CANCELLED")).toHaveLength(1);
  });

  it("enqueues exactly one ORDER_CANCELLED row for a paid cancel", async () => {
    const f = await safepayFixture({ settle: true });
    expect((await adminUpdateOrderStatus(f.orderId, "CANCELLED")).ok).toBe(true);
    const rows = await outboxRows(f.email, "ORDER_CANCELLED");
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0])).toMatchObject({ orderId: f.orderId, reference: f.reference });
  });

  it("enqueues exactly one ORDER_CANCELLED row from the Safepay cancel page, and a second visit does not re-notify", async () => {
    const f = await cancelPageFixture();
    const first = await resolveSafepayCancel({ config: cancelConfig, database: db as never, query: { state: f.state }, owner: f.owner });
    expect(first.kind).toBe("released");
    const second = await resolveSafepayCancel({ config: cancelConfig, database: db as never, query: { state: f.state }, owner: f.owner });
    expect(second.kind).toBe("already_closed");
    expect(await outboxRows(f.email, "ORDER_CANCELLED")).toHaveLength(1);
  });
});

describe("verified payment success and final failure", () => {
  it("enqueues nothing at tracker creation, then ORDER_CONFIRMED + ORDER_PAYMENT_SUCCEEDED at verified settlement", async () => {
    const f = await safepayFixture({ settle: false });
    expect(await outboxRows(f.email)).toHaveLength(0);
    const result = await processObservation(f.observation);
    expect(result).toEqual({ kind: "settled" });
    const rows = await outboxRows(f.email);
    expect(rows.map(r => r.type).sort()).toEqual(["ORDER_CONFIRMED", "ORDER_PAYMENT_SUCCEEDED"]);
    expect(payloadOf(rows.find(r => r.type === "ORDER_CONFIRMED")!)).toMatchObject({ orderId: f.orderId, paymentMethod: "ONLINE" });
    expect(payloadOf(rows.find(r => r.type === "ORDER_PAYMENT_SUCCEEDED")!)).toMatchObject({ orderId: f.orderId });
  });

  it("does not send a failure email for a non-final decline (payment.failed → UNCERTAIN)", async () => {
    const f = await safepayFixture({ settle: false });
    const result = await processObservation({ ...f.observation, observationId: randomUUID(), kind: "UNCERTAIN", capturedMinor: null });
    expect(result).toEqual({ kind: "recorded" });
    expect(await outboxRows(f.email)).toHaveLength(0);
  });

  it("does not send a failure email when a reservation expires unstarted", async () => {
    const email = randomUUID() + "@example.invalid"; emails.push(email);
    const { product } = await seedProduct();
    const user = await db.user.create({ data: { email } }); userIds.push(user.id);
    const owner = { kind: "USER" as const, userId: user.id };
    const cart = await db.cart.create({ data: { userId: user.id, items: { create: [{ productId: product.id, quantity: 1 }] } } });
    cartIds.push(cart.id);
    const run = createSafepayPendingOrderService({ database, getSettings: async () => settings,
      environment: "sandbox", merchantAccountRef: "synthetic-account", reservationTtlMs: 600_000, now: clock });
    const prepared = await run(checkoutInput("ONLINE", email), { cartId: cart.id, owner });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") throw new Error("pending order failed");
    orderIds.push(prepared.orderId); paymentIds.push(prepared.paymentId);
    expect((await reservations.expireBatch()).some(r => r.orderId === prepared.orderId)).toBe(false);
    time = new Date(baseTime.getTime() + 600_001);
    const expired = (await reservations.expireBatch()).find(r => r.orderId === prepared.orderId);
    expect(expired?.result).toEqual({ ok: true, outcome: "RELEASED" });
    expect(await outboxRows(email)).toHaveLength(0);
  });

  it("sends exactly one failure email when a verified FAILURE_CONFIRMED observation arrives", async () => {
    const f = await safepayFixture({ settle: false });
    const result = await processObservation({ ...f.observation, observationId: randomUUID(), kind: "FAILURE_CONFIRMED", capturedMinor: null }, "RECONCILIATION");
    expect(result).toEqual({ kind: "review_required", failureConfirmed: true });
    const rows = await outboxRows(f.email, "ORDER_PAYMENT_FAILED");
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0])).toMatchObject({ orderId: f.orderId, reference: f.reference });
    await deliverAllFor(f.email);
    expect(sent.paymentFailed.filter(s => s.reference === f.reference)).toHaveLength(1);
  });
});

describe("refund success email", () => {
  it("fires only after a confirmed refund, not on submission", async () => {
    const f = await safepayFixture({ settle: true });
    const created = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(50000), requestedByUserId: "admin-1" });
    if (created.kind !== "created") throw new Error("expected created refund");
    refundIds.push(created.refundId);
    expect(await outboxRows(f.email, "ORDER_REFUND_SUCCEEDED")).toHaveLength(0);
    const result = await processObservation(refundObservation(f, "50000"));
    expect(result.kind).toBe("settled");
    const rows = await outboxRows(f.email, "ORDER_REFUND_SUCCEEDED");
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0])).toMatchObject({ orderId: f.orderId, refundAmountMinor: "50000" });
  });

  it("enqueues one row per confirmed partial refund", async () => {
    const f = await safepayFixture({ settle: true });
    // Distinct amounts (like the settlement suite's cumulative test): two
    // observations with the same amount AND the same occurredAt are
    // indistinguishable from a duplicate delivery and are recorded, not
    // settled, by design.
    const firstAmount = f.capturedMinor / BigInt(4);
    const secondAmount = f.capturedMinor - firstAmount;
    const first = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: firstAmount, requestedByUserId: "admin-1" });
    if (first.kind !== "created") throw new Error("expected created refund");
    const second = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: secondAmount, requestedByUserId: "admin-1" });
    if (second.kind !== "created") throw new Error("expected created refund");
    refundIds.push(first.refundId, second.refundId);
    expect(await processObservation(refundObservation(f, firstAmount.toString()))).toMatchObject({ kind: "settled" });
    expect(await processObservation(refundObservation(f, secondAmount.toString()))).toMatchObject({ kind: "settled" });
    const rows = await outboxRows(f.email, "ORDER_REFUND_SUCCEEDED");
    expect(rows).toHaveLength(2);
    expect(payloadOf(rows[0]).refundAmountMinor).toBe(firstAmount.toString());
    expect(payloadOf(rows[1]).refundAmountMinor).toBe(secondAmount.toString());
    expect(payloadOf(rows[0]).refundIds).not.toEqual(payloadOf(rows[1]).refundIds);
  });
});

describe("verification callbackUrl and malformed rows", () => {
  it("delivers a verification link carrying the callbackUrl, and /account without one", async () => {
    const withCb = randomUUID() + "@example.invalid"; emails.push(withCb);
    const withoutCb = randomUUID() + "@example.invalid"; emails.push(withoutCb);
    const u1 = await db.user.create({ data: { email: withCb, passwordHash: "synthetic-hash" } }); userIds.push(u1.id);
    const u2 = await db.user.create({ data: { email: withoutCb, passwordHash: "synthetic-hash" } }); userIds.push(u2.id);
    await resendVerificationEmail(withCb, "/checkout");
    await resendVerificationEmail(withoutCb);
    await deliverAllFor(withCb);
    await deliverAllFor(withoutCb);
    expect(sent.verification.filter(v => v.email === withCb)).toHaveLength(1);
    expect(sent.verification.filter(v => v.email === withoutCb)).toHaveLength(1);
    expect(sent.verification.find(v => v.email === withCb)?.callbackUrl).toBe("/checkout");
    expect(sent.verification.find(v => v.email === withoutCb)?.callbackUrl).toBe("/account");
  });

  it("a row with a missing payload ends FAILED with a visible error instead of silently dropping", async () => {
    const email = randomUUID() + "@example.invalid"; emails.push(email);
    const row = await db.emailOutbox.create({ data: { type: "ORDER_CONFIRMED", email, payload: null } });
    const t0 = Date.now();
    // Backoff after attempt n: 30s, 60s, 120s, 240s — sweep five times.
    for (const offset of [0, 31_000, 92_000, 213_000, 454_000]) {
      await deliverPendingOutboxEmails(50, new Date(t0 + offset));
    }
    const final = await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(final.status).toBe("FAILED");
    expect(final.attempts).toBe(5);
    expect(final.lastError ?? "").toMatch(/payload/i);
    expect(sent.confirmed.filter(s => s.email === email)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stream G (Phase 3 final — email system verification). Chunk 7-final
// covered the per-event enqueue/delivery tests above; these describes close
// the gaps it left: failure isolation on the settlement path (audit
// scenario 16 only covered placeOrder), a transient send failure on an
// order row with recovery, a FAILED order row retried end to end, payload
// dedup across distinct orders for one customer, the CONFIRMED status
// email, and the viewer side of the stuck-outbox signal.
// ---------------------------------------------------------------------------

describe("settlement failure isolation (Stream G)", () => {
  it("a failing enqueue does not fail a verified settlement", async () => {
    const f = await safepayFixture({ settle: false });
    // The first enqueue (ORDER_CONFIRMED) throws; the notification service
    // captures it and the settlement must still complete.
    const create = vi.spyOn(db.emailOutbox, "create").mockRejectedValueOnce(new Error("synthetic outbox outage"));
    const result = await processObservation(f.observation);
    create.mockRestore();
    expect(result).toEqual({ kind: "settled" });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.orderId } });
    expect(order.paymentStatus).toBe("PAID");
    expect(await outboxRows(f.email, "ORDER_CONFIRMED")).toHaveLength(0);
    // The second enqueue (payment success) still ran after the first failed.
    expect(await outboxRows(f.email, "ORDER_PAYMENT_SUCCEEDED")).toHaveLength(1);
  });
});

describe("transient delivery failure and retry (Stream G)", () => {
  it("a failed order-email send retries with backoff, then delivers", async () => {
    const f = await codOrder();
    vi.mocked(sendOrderConfirmedEmail).mockRejectedValueOnce(new Error("SMTP connection refused"));
    const first = await deliverPendingOutboxEmails(50);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    const pending = await outboxRows(f.email, "ORDER_CONFIRMED");
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("PENDING");
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].lastError ?? "").toContain("SMTP connection refused");
    expect(pending[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(sent.confirmed.filter(s => s.reference === f.reference)).toHaveLength(0);
    // Backoff elapsed: the next sweep delivers the email.
    await db.emailOutbox.updateMany({
      where: { email: f.email },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const second = await deliverPendingOutboxEmails(50);
    expect(second.delivered).toBeGreaterThanOrEqual(1);
    expect(sent.confirmed.filter(s => s.reference === f.reference)).toHaveLength(1);
    expect(await outboxRows(f.email, "ORDER_CONFIRMED")).toHaveLength(0);
  });

  it("a FAILED order row is retryable end to end and then delivers", async () => {
    const f = await codOrder();
    const rows = await outboxRows(f.email, "ORDER_CONFIRMED");
    expect(rows).toHaveLength(1);
    await db.emailOutbox.update({
      where: { id: rows[0].id },
      data: { status: "FAILED", attempts: 5, lastError: "Error: SMTP connection refused" },
    });
    expect(await retryEmailOutboxEntry(rows[0].id)).toBe(true);
    const retried = await db.emailOutbox.findUniqueOrThrow({ where: { id: rows[0].id } });
    expect(retried.status).toBe("PENDING");
    expect(retried.attempts).toBe(0);
    expect(retried.lastError).toBeNull();
    await deliverAllFor(f.email);
    expect(sent.confirmed.filter(s => s.reference === f.reference)).toHaveLength(1);
    expect(await outboxRows(f.email)).toHaveLength(0);
  });
});

describe("payload dedup across distinct events (Stream G)", () => {
  // A COD order for an already-created user, so two orders can share one
  // customer email. One cart per user (Cart.userId is unique) and
  // placeOrder consumes its lines, so the second order reuses the same cart
  // row with a fresh line instead of creating a second cart.
  async function codOrderAs(user: { id: string }, email: string) {
    const { product } = await seedProduct();
    let cart = await db.cart.findUnique({ where: { userId: user.id } });
    if (!cart) {
      cart = await db.cart.create({ data: { userId: user.id } });
      cartIds.push(cart.id);
    }
    await db.cartItem.create({ data: { cartId: cart.id, productId: product.id, quantity: 1 } });
    const result = await placeOrder(checkoutInput("COD", email), user.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("COD placement failed: " + result.error);
    orderIds.push(result.orderId);
    return { orderId: result.orderId, reference: result.reference };
  }

  it("two orders for the same customer enqueue two rows; re-triggering one event does not add a third", async () => {
    const email = randomUUID() + "@example.invalid"; emails.push(email);
    const user = await db.user.create({ data: { email } }); userIds.push(user.id);
    const first = await codOrderAs(user, email);
    const second = await codOrderAs(user, email);
    expect(first.orderId).not.toBe(second.orderId);
    expect(await outboxRows(email, "ORDER_CONFIRMED")).toHaveLength(2);
    // Re-triggering the first order's confirmation collapses on the
    // (type, email, payload) key — no third row.
    await enqueueOrderConfirmedEmail({ orderId: first.orderId });
    expect(await outboxRows(email, "ORDER_CONFIRMED")).toHaveLength(2);
  });

  it("verification rows with different callbackUrls are distinct; the same one dedups", async () => {
    const email = randomUUID() + "@example.invalid"; emails.push(email);
    await enqueueVerificationEmail({ email, callbackUrl: "/checkout" });
    await enqueueVerificationEmail({ email, callbackUrl: "/checkout" });
    await enqueueVerificationEmail({ email, callbackUrl: "/account/orders" });
    const rows = await outboxRows(email, "EMAIL_VERIFICATION");
    expect(rows).toHaveLength(2);
    expect(rows.map(r => JSON.parse(r.payload!).callbackUrl).sort()).toEqual(["/account/orders", "/checkout"]);
  });
});

describe("order status email for CONFIRMED (Stream G)", () => {
  it("enqueues one ORDER_STATUS row when the CONFIRMED status is notified", async () => {
    // Reachability note (Stream G finding): no current flow routes through
    // adminUpdateOrderStatus with CONFIRMED — COD orders are born CONFIRMED
    // (D3) and Safepay settlement sets CONFIRMED directly in the settlement
    // transaction (payment-settlement.service.ts), while the managed guard
    // (canFulfilManagedOrder) blocks manually confirming an unpaid managed
    // order. So this verifies the hook at the service level, where it is
    // reachable: the enqueue + template for CONFIRMED work, and the row
    // fires if a future flow ever transitions to CONFIRMED through the
    // admin path. The template phrase is covered in
    // order-email-templates.test.ts.
    const f = await codOrder();
    await enqueueOrderStatusEmail({ orderId: f.orderId, status: "CONFIRMED" });
    const rows = await outboxRows(f.email, "ORDER_STATUS");
    expect(rows).toHaveLength(1);
    expect(payloadOf(rows[0])).toMatchObject({ orderId: f.orderId, status: "CONFIRMED" });
  });
});

// Last: the row below is left PENDING with a past nextAttemptAt, so no
// sweep may run after this describe (a sweep would deliver it). The
// afterAll cleanup deletes it by email.
describe("stuck outbox visibility (Stream G)", () => {
  it("an ageing PENDING order row stays visible in the viewer list with its attempts and last error", async () => {
    const f = await codOrder();
    const rows = await outboxRows(f.email, "ORDER_CONFIRMED");
    expect(rows).toHaveLength(1);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.emailOutbox.update({
      where: { id: rows[0].id },
      data: {
        createdAt: twoHoursAgo,
        attempts: 2,
        lastError: "Error: SMTP connection refused",
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
    });
    // The viewer side of the stuck-outbox signal: the row is listed under
    // PENDING with its age, attempts and last error, and the detail lookup
    // resolves its order reference. (The heartbeat going stale when the
    // worker stops is Stream F's proof; this is the viewer half.)
    const listed = await listEmailOutboxEntries({ status: "PENDING", page: 1, perPage: 100 });
    const entry = listed.entries.find((e) => e.email === f.email);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("PENDING");
    expect(entry!.attempts).toBe(2);
    expect(entry!.lastError).toBe("Error: SMTP connection refused");
    expect(entry!.createdAt.getTime()).toBeLessThan(Date.now() - 60 * 60 * 1000);
    const detail = await getEmailOutboxEntry(entry!.id);
    expect(emailOutboxOrderReference(detail!.payload)).toBe(f.reference);
  });
});
