import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../generated/postgres-client";
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
  return { db: new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }) };
});
import { db } from "@/lib/db";
import { createSafepayPendingOrderService } from "@/services/safepay-pending-order.service";
import { bindCheckoutOwner } from "@/services/safepay-attempt.store";
import { createPaymentSettlementService, type PaymentPersistence } from "@/services/payment-settlement.service";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentRefundService, type RefundSubmissionOutcome } from "@/services/payment-refund.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { trackerIdentity, type PaymentObservation, type VerificationInput } from "@/lib/payments/evidence-contract";
import type { SafepayProvider } from "@/lib/safepay/provider";
import { DEFAULT_SETTINGS } from "@/services/settings.service";

assertDisposableTestDatabase();
const database = db as unknown as PaymentPersistence;
const baseTime = new Date("2026-11-05T20:00:00.000Z"); let time = new Date(baseTime);
const clock = () => new Date(time);
const options = { now: clock, reconcileDelayMs: 60_000 };
const key = randomBytes(32), vault = createPaymentPayloadVault("synthetic-key", new Map([["synthetic-key", key]]));
const inbox = createPaymentWebhookService(database, vault, options);
const settlement = createPaymentSettlementService(database, options);
const reconciliation = createPaymentReconciliationService(database, inbox, clock);
const settings = { ...DEFAULT_SETTINGS, bank_transfer_enabled: true };
const productIds: string[] = [], categoryIds: string[] = [], cartIds: string[] = [], userIds: string[] = [],
  eventIds: string[] = [], refundIds: string[] = [], paymentIds: string[] = [];
const submittedViaProvider: Array<{ trackerToken: string; amountMinor: bigint }> = [];

// Deterministic provider stub: records submissions and replays scripted outcomes.
type ProviderRefundOutcome = Awaited<ReturnType<SafepayProvider["submitRefund"]>>;
function providerStub(outcomes: ProviderRefundOutcome[] = []): Pick<SafepayProvider, "submitRefund"> {
  let call = 0;
  return {
    submitRefund: vi.fn(async (input: { trackerToken: string; amountMinor: bigint }) => {
      submittedViaProvider.push(input);
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return outcome ?? { kind: "submitted" as const };
    }),
  };
}
const refundOptions = {
  now: clock,
  environment: "sandbox", merchantAccountRef: "synthetic-account",
  pollDelayMs: 1_000, maxConfirmationAttempts: 2, submitGraceMs: 120_000,
  // Windows default to disabled here; dedicated tests opt in with real values.
  reversalWindowMs: 0, cardRefundWindowMs: Number.MAX_SAFE_INTEGER,
};
const refunds = createPaymentRefundService(database, providerStub(), refundOptions);

function checkoutInput(method: "ONLINE" | "COD" | "BANK_TRANSFER" = "ONLINE") {
  return { idempotencyKey: randomUUID(), paymentMethod: method, deliveryMethod: "STANDARD" as const,
    customer: { name: "Synthetic Buyer", email: "synthetic@example.invalid", phone: "03001234567" },
    address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" } };
}
async function fixture(opts: { settle?: boolean } = {}) {
  const category = await db.category.create({ data: { name: "Synthetic " + randomUUID(), slug: randomUUID() } });
  categoryIds.push(category.id);
  const product = await db.product.create({ data: { name: "Synthetic refund item", slug: randomUUID(),
    categoryId: category.id, price: 1000, status: "PUBLISHED", inventory: { create: { quantity: 5 } } } });
  productIds.push(product.id);
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid" } });
  userIds.push(user.id);
  const owner = { kind: "USER" as const, userId: user.id };
  const cart = await db.cart.create({ data: { userId: user.id, items: { create: [{ productId: product.id, quantity: 2 }] } } });
  cartIds.push(cart.id);
  const run = createSafepayPendingOrderService({ database, getSettings: async () => settings, environment: "sandbox",
    merchantAccountRef: "synthetic-account", reservationTtlMs: 600_000, now: clock });
  const prepared = await run(checkoutInput("ONLINE"), { cartId: cart.id, owner });
  if (prepared.kind !== "ready") throw new Error("Synthetic pending order failed: " + prepared.code);
  paymentIds.push(prepared.paymentId);
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
  if (opts.settle === false) {
    return { ...prepared, product, owner, token, payment, observation, capturedMinor: payment.expectedAmountMinor! };
  }
  const settled = await processObservation(observation);
  if (settled.kind !== "settled") throw new Error("Synthetic capture failed: " + JSON.stringify(settled));
  return { ...prepared, product, owner, token, payment, observation, capturedMinor: payment.expectedAmountMinor! };
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
function refundObservation(f: Awaited<ReturnType<typeof fixture>>, refundMinor: string, opts: {
  kind?: PaymentObservation["kind"]; providerState?: string | null; occurredAt?: string | null;
} = {}): PaymentObservation {
  return { provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    merchantIdentity: "SIMULATED_MERCHANT", observationId: randomUUID(), orderId: f.orderId, paymentId: f.paymentId,
    attemptNumber: 1, trackerToken: f.token, owner: bindCheckoutOwner(f.owner), currency: "PKR",
    amountMinor: "0", kind: opts.kind ?? "REFUND_CONFIRMED", capturedMinor: null, refundMinor,
    providerState: opts.providerState === undefined ? "TRACKER_PARTIAL_REFUND" : opts.providerState,
    occurredAt: opts.occurredAt === undefined ? time.toISOString() : opts.occurredAt };
}
function reporterObservation(f: Awaited<ReturnType<typeof fixture>>, providerState: string): PaymentObservation {
  return { provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    merchantIdentity: "SIMULATED_MERCHANT", observationId: randomUUID(), orderId: f.orderId, paymentId: f.paymentId,
    attemptNumber: 1, trackerToken: f.token, owner: bindCheckoutOwner(f.owner), currency: "PKR",
    amountMinor: f.capturedMinor.toString(), kind: providerState === "TRACKER_REVERSED" ? "REVERSAL_NOTICE" : "REFUND_NOTICE",
    capturedMinor: null, refundMinor: null, providerState, occurredAt: null };
}
/** Test isolation for sweep tests: park open rows left by earlier tests (audit-safe). */
async function quarantinePriorOpenRefunds() {
  await db.paymentRefund.updateMany({ where: { status: { in: ["REQUESTED", "SUBMITTING", "PENDING"] } },
    data: { status: "REVIEW_REQUIRED", reviewReason: "TEST_ISOLATION" } });
}
async function state(id: string) {
  return db.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
}
async function rows(paymentId: string) {
  return db.paymentRefund.findMany({ where: { paymentId }, orderBy: [{ requestedAt: "asc" }, { id: "asc" }] });
}
async function openSum(paymentId: string) {
  return (await rows(paymentId)).filter(r => ["REQUESTED", "SUBMITTING", "PENDING"].includes(r.status))
    .reduce((sum, r) => sum + r.amountMinor, BigInt(0));
}
function failingDatabase(model: string, operation: string, failAt = 1): PaymentPersistence {
  return { $transaction: ((fn: (tx: Prisma.TransactionClient) => unknown, txOptions?: object) => db.$transaction(async tx => {
    let calls = 0;
    const wrapped = new Proxy(tx, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== model) return typeof value === "function" ? value.bind(target) : value;
      return new Proxy(value, { get(delegate, name) {
        const method = Reflect.get(delegate, name);
        if (name === operation) return async (...args: unknown[]) => {
          if (++calls === failAt) throw new Error("Synthetic private rollback diagnostic");
          return method.apply(delegate, args);
        };
        return typeof method === "function" ? method.bind(delegate) : method;
      } });
    } }); return fn(wrapped as unknown as Prisma.TransactionClient);
  }, txOptions)) as PaymentPersistence["$transaction"] };
}
beforeEach(() => { time = new Date(baseTime); simulated.enabled = true; submittedViaProvider.length = 0; });
afterAll(async () => {
  const orders = (await db.order.findMany({ where: { items: { some: { productId: { in: productIds } } } }, select: { id: true } })).map(o => o.id);
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await db.paymentWebhookEvent.deleteMany({ where: { OR: [{ id: { in: eventIds } }, { payment: { orderId: { in: orders } } }] } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await db.couponReservation.deleteMany({ where: { orderId: { in: orders } } });
  await db.order.updateMany({ where: { id: { in: orders } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orders } } }); await db.cart.deleteMany({ where: { id: { in: cartIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } }); await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("Refund accounting from verified webhook evidence", () => {
  it("settles a full refund: row SUCCEEDED, payment REFUNDED, order paymentStatus REFUNDED, evidence linked", async () => {
    const f = await fixture();
    const created = await refunds.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    refundIds.push(created.refundId);
    expect(created.submission.kind).toBe("submitted");
    expect(submittedViaProvider).toEqual([{ trackerToken: f.token, amountMinor: f.capturedMinor }]);
    let row = (await rows(f.paymentId))[0];
    expect(row).toMatchObject({ status: "PENDING", type: "FULL", initiatedBy: "ADMIN", currency: "PKR" });

    const result = await processObservation(refundObservation(f, f.capturedMinor.toString(),
      { providerState: "TRACKER_REFUNDED" }));
    expect(result).toEqual({ kind: "settled" });
    row = (await rows(f.paymentId))[0];
    expect(row).toMatchObject({ status: "SUCCEEDED", reconcileStatus: "VERIFIED",
      providerState: "TRACKER_REFUNDED" });
    expect(row.confirmedAt).not.toBeNull(); expect(row.settledAt).not.toBeNull();
    const order = await state(f.orderId);
    expect(order).toMatchObject({ status: "CONFIRMED", paymentStatus: "REFUNDED" });
    expect(order.payments[0]).toMatchObject({ status: "REFUNDED", refundedAmountMinor: f.capturedMinor });
    const evidence = await db.paymentEvidence.findFirst({ where: { refundId: row.id } });
    expect(evidence).toMatchObject({ decision: "REFUND_SETTLED", observedRefundedMinor: f.capturedMinor,
      observedProviderState: "TRACKER_REFUNDED" });
    // Inventory is deliberately untouched by refunds.
    expect((await db.inventory.findUniqueOrThrow({ where: { productId: f.product.id } })).quantity).toBe(3);
  });

  it("keeps a partial refund distinguishable: payment stays PAID with advanced refundedAmountMinor", async () => {
    const f = await fixture();
    const created = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(50000),
      requestedByUserId: "admin-1" });
    if (created.kind !== "created") throw new Error("expected created");
    refundIds.push(created.refundId);
    expect((await rows(f.paymentId))[0]).toMatchObject({ type: "PARTIAL", amountMinor: BigInt(50000) });
    expect(await processObservation(refundObservation(f, "50000"))).toEqual({ kind: "settled" });
    const order = await state(f.orderId);
    expect(order).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(order.payments[0]).toMatchObject({ status: "PAID", refundedAmountMinor: BigInt(50000) });
  });

  it("supports multiple partial refunds cumulatively up to the captured amount", async () => {
    const f = await fixture();
    const firstAmount = f.capturedMinor / BigInt(4);
    const secondAmount = f.capturedMinor - firstAmount;
    const first = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: firstAmount, requestedByUserId: "admin-1" });
    const second = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: secondAmount, requestedByUserId: "admin-1" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected both created");
    refundIds.push(first.refundId, second.refundId);
    expect(await processObservation(refundObservation(f, firstAmount.toString()))).toEqual({ kind: "settled" });
    let order = await state(f.orderId);
    expect(order.payments[0]).toMatchObject({ status: "PAID", refundedAmountMinor: firstAmount });
    expect(await processObservation(refundObservation(f, secondAmount.toString()))).toEqual({ kind: "settled" });
    order = await state(f.orderId);
    expect(order).toMatchObject({ paymentStatus: "REFUNDED" });
    expect(order.payments[0]).toMatchObject({ status: "REFUNDED", refundedAmountMinor: f.capturedMinor });
    expect(await openSum(f.paymentId)).toBe(BigInt(0));
  });

  it("rejects cumulative refunds beyond the captured amount and never moves money", async () => {
    const f = await fixture();
    const first = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(60000), requestedByUserId: "admin-1" });
    if (first.kind !== "created") throw new Error("expected created");
    refundIds.push(first.refundId);
    // Remaining refundable = captured - open(60000); anything above must be refused.
    const over = await refunds.requestRefund({ paymentId: f.paymentId,
      amountMinor: f.capturedMinor, requestedByUserId: "admin-1" });
    expect(over).toMatchObject({ kind: "rejected", code: "REFUND_EXCEEDS_REMAINING" });
    // An authenticated webhook claiming more than the captured amount is quarantined for review.
    expect(await processObservation(refundObservation(f, (f.capturedMinor + BigInt(1)).toString())))
      .toEqual({ kind: "review_required" });
    const order = await state(f.orderId);
    expect(order.payments[0]).toMatchObject({ status: "PAID", refundedAmountMinor: null,
      reconcileStatus: "REVIEW_REQUIRED" });
  });

  it("prevents duplicate refund operations via the idempotency key", async () => {
    const f = await fixture();
    const idempotencyKey = randomUUID();
    const first = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(10000),
      idempotencyKey, requestedByUserId: "admin-1" });
    const replay = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(10000),
      idempotencyKey, requestedByUserId: "admin-1" });
    if (first.kind !== "created") throw new Error("expected created");
    expect(replay).toMatchObject({ kind: "existing", refundId: first.refundId });
    expect(await db.paymentRefund.count({ where: { paymentId: f.paymentId } })).toBe(1);
    const conflict = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(10000),
      idempotencyKey: randomUUID().slice(0, 16).padEnd(16, "x"), requestedByUserId: "admin-1" });
    expect(["created", "rejected", "review_required"]).toContain(conflict.kind);
    const wrongPayment = await refunds.requestRefund({ paymentId: "nonexistent-payment", amountMinor: BigInt(10000),
      idempotencyKey: randomUUID().slice(0, 16).padEnd(16, "x"), requestedByUserId: "admin-1" });
    expect(wrongPayment.kind === "rejected" || wrongPayment.kind === "existing").toBe(true);
  });

  it("processes the same refund webhook only once (duplicate delivery is inert)", async () => {
    const f = await fixture();
    const created = await refunds.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    if (created.kind !== "created") throw new Error("expected created");
    refundIds.push(created.refundId);
    const observation = refundObservation(f, f.capturedMinor.toString(), { providerState: "TRACKER_REFUNDED" });
    const received = await receive(observation);
    expect(await inbox.process(received.eventId)).toEqual({ kind: "settled" });
    expect(await inbox.process(received.eventId)).toEqual({ kind: "duplicate" });
    expect(await inbox.receive(received.input).then(r => r.kind)).toBe("duplicate");
    expect(await state(f.orderId).then(o => o.payments[0].refundedAmountMinor)).toBe(f.capturedMinor);
  });

  it("rolls back atomically when the refund row finalization fails mid-transaction", async () => {
    const f = await fixture();
    const created = await refunds.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    if (created.kind !== "created") throw new Error("expected created");
    refundIds.push(created.refundId);
    const failing = createPaymentWebhookService(failingDatabase("paymentRefund", "updateMany"), vault, options);
    const observation = refundObservation(f, f.capturedMinor.toString(), { providerState: "TRACKER_REFUNDED" });
    const received = await receive(observation);
    expect(await failing.process(received.eventId)).toEqual({ kind: "blocked", code: "PERSISTENCE_UNAVAILABLE" });
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "PENDING" });
    expect(await state(f.orderId).then(o => o.payments[0].refundedAmountMinor)).toBeNull();
  });

  it("rejects concurrent full-remaining refund requests so the balance can never be exceeded", async () => {
    const f = await fixture();
    const [a, b] = await Promise.allSettled([
      refunds.requestRefund({ paymentId: f.paymentId, amountMinor: f.capturedMinor, requestedByUserId: "admin-1" }),
      refunds.requestRefund({ paymentId: f.paymentId, amountMinor: f.capturedMinor, requestedByUserId: "admin-2" }),
    ]);
    const outcomes = [a, b].map(r => r.status === "fulfilled" ? r.value : { kind: "threw" });
    const created = outcomes.filter(o => o.kind === "created");
    const rejected = outcomes.filter(o => o.kind === "rejected");
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: expect.stringMatching(/NOTHING_TO_REFUND|REFUND_EXCEEDS_REMAINING|NOT_REFUNDABLE/) });
    expect(await openSum(f.paymentId)).toBeLessThanOrEqual(f.capturedMinor);
  });
});

describe("Refund webhook anomalies stay quarantined for manual review", () => {
  it("keeps routing unattributable refund notices to review without money movement", async () => {
    const f = await fixture();
    expect(await processObservation(refundObservation(f, "1", { kind: "REFUND_NOTICE" }))).toEqual({ kind: "review_required" });
    expect(await state(f.orderId)).toMatchObject({ paymentStatus: "PAID", paymentReviewStatus: "REQUIRED" });
    expect(await state(f.orderId).then(o => o.payments[0].refundedAmountMinor)).toBeNull();
  });

  it("routes refund events for an unsettled payment to review", async () => {
    const f = await fixture({ settle: false }); // bound but still PENDING (uncaptured)
    expect(await processObservation(refundObservation(f, "1000", { providerState: null }))).toEqual({ kind: "review_required" });
    const order = await state(f.orderId);
    expect(order).toMatchObject({ paymentStatus: "PENDING", paymentReviewStatus: "REQUIRED" });
    expect(order.payments[0].refundedAmountMinor).toBeNull();
  });

  it("routes contradicting refund-state events and reversal notices to review, never to money movement", async () => {
    const f = await fixture();
    expect(await processObservation(refundObservation(f, "50000", { kind: "REVERSAL_NOTICE",
      providerState: "TRACKER_REVERSED" }))).toEqual({ kind: "review_required" });
    let order = await state(f.orderId);
    expect(order.payments[0]).toMatchObject({ status: "PAID", refundedAmountMinor: null,
      reconcileStatus: "REVIEW_REQUIRED" });
    expect(order).toMatchObject({ paymentReviewStatus: "REQUIRED" });
    // Contradictory refund event (capture state) with an asserted amount keeps the amount in evidence.
    expect(await processObservation(refundObservation(f, "50000", { kind: "REVIEW_REQUIRED",
      providerState: "TRACKER_ENDED" }))).toEqual({ kind: "review_required" });
    order = await state(f.orderId);
    expect(order.payments[0].refundedAmountMinor).toBeNull();
  });
});

describe("Reporter-driven refund reconciliation", () => {
  it("finalizes all open rows when the reporter proves TRACKER_REFUNDED and the rows account for the balance", async () => {
    const f = await fixture();
    const a = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: f.capturedMinor / BigInt(2), requestedByUserId: "admin-1" });
    const b = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: f.capturedMinor - (f.capturedMinor / BigInt(2)), requestedByUserId: "admin-1" });
    if (a.kind !== "created" || b.kind !== "created") throw new Error("expected both created");
    refundIds.push(a.refundId, b.refundId);
    expect(await processObservation(reporterObservation(f, "TRACKER_REFUNDED"), "RECONCILIATION")).toEqual({ kind: "settled" });
    const all = await rows(f.paymentId);
    expect(all.every(r => r.status === "SUCCEEDED")).toBe(true);
    const order = await state(f.orderId);
    expect(order).toMatchObject({ paymentStatus: "REFUNDED" });
    expect(order.payments[0]).toMatchObject({ status: "REFUNDED", refundedAmountMinor: f.capturedMinor });
  });

  it("records an external dashboard full refund from reporter evidence when no local rows exist", async () => {
    const f = await fixture();
    expect(await processObservation(reporterObservation(f, "TRACKER_REFUNDED"), "RECONCILIATION")).toEqual({ kind: "settled" });
    const all = await rows(f.paymentId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "SUCCEEDED", initiatedBy: "PROVIDER", type: "FULL",
      amountMinor: f.capturedMinor });
    const order = await state(f.orderId);
    expect(order).toMatchObject({ paymentStatus: "REFUNDED" });
    expect(order.payments[0]).toMatchObject({ status: "REFUNDED", refundedAmountMinor: f.capturedMinor });
  });

  it("treats a repeated external full-refund observation as already settled, never double-counting", async () => {
    const f = await fixture();
    expect(await processObservation(reporterObservation(f, "TRACKER_REFUNDED"), "RECONCILIATION")).toEqual({ kind: "settled" });
    // A distinct observation id (fresh event) asserting the same already-accounted refund.
    expect(await processObservation(refundObservation(f, "50000"), "WEBHOOK")).toEqual({ kind: "review_required" });
    const order = await state(f.orderId);
    expect(order.payments[0]).toMatchObject({ status: "REFUNDED", refundedAmountMinor: f.capturedMinor });
    expect(await db.paymentRefund.count({ where: { paymentId: f.paymentId } })).toBe(1);
  });

  it("keeps rows open when the reporter shows a partial refund it cannot attribute", async () => {
    const f = await fixture();
    const a = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(30000), requestedByUserId: "admin-1" });
    if (a.kind !== "created") throw new Error("expected created");
    refundIds.push(a.refundId);
    expect(await processObservation(reporterObservation(f, "TRACKER_PARTIAL_REFUND"), "RECONCILIATION")).toEqual({ kind: "recorded" });
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "PENDING" });
    expect(await state(f.orderId).then(o => o.payments[0].refundedAmountMinor)).toBeNull();
    // No local rows + an unattributed external partial refund → manual review.
    const f2 = await fixture();
    expect(await processObservation(reporterObservation(f2, "TRACKER_PARTIAL_REFUND"), "RECONCILIATION")).toEqual({ kind: "review_required" });
    expect(await state(f2.orderId)).toMatchObject({ paymentReviewStatus: "REQUIRED" });
  });

  it("handles a refund webhook for an external dashboard refund (no open rows) with a stable operation key", async () => {
    const f = await fixture();
    expect(await processObservation(refundObservation(f, "40000"))).toEqual({ kind: "settled" });
    const all = await rows(f.paymentId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "SUCCEEDED", initiatedBy: "PROVIDER", type: "PARTIAL", amountMinor: BigInt(40000) });
    const order = await state(f.orderId);
    expect(order.payments[0]).toMatchObject({ status: "PAID", refundedAmountMinor: BigInt(40000) });
  });

  it("does not double-count a redelivered external refund event asserting the same refunded_at and amount", async () => {
    const f = await fixture();
    const occurredAt = time.toISOString();
    expect(await processObservation(refundObservation(f, "40000", { occurredAt, providerState: null }))).toEqual({ kind: "settled" });
    // Same provider refund timestamp + amount under a different observation id: the stable
    // external operation key makes the second event an inert already-settled record.
    const replay = { ...refundObservation(f, "40000", { occurredAt, providerState: null }), observationId: randomUUID() };
    expect(await processObservation(replay)).toEqual({ kind: "recorded" });
    expect(await db.paymentRefund.count({ where: { paymentId: f.paymentId } })).toBe(1);
    expect(await state(f.orderId).then(o => o.payments[0].refundedAmountMinor)).toBe(BigInt(40000));
  });
});

describe("Refund business rules", () => {
  it("parks refunds inside the documented 24-hour reversal window instead of submitting one", async () => {
    const f = await fixture();
    const guarded = createPaymentRefundService(database, providerStub(), { ...refundOptions, reversalWindowMs: 86_400_000 });
    const result = await guarded.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    expect(result).toMatchObject({ kind: "review_required", reason: "REFUND_WINDOW_REVERSAL_24H" });
    if (result.kind !== "review_required") return;
    refundIds.push(result.refundId);
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "REVIEW_REQUIRED", reviewReason: "REFUND_WINDOW_REVERSAL_24H" });
    expect(submittedViaProvider).toHaveLength(0);
    // After the window passes, the same payment refunds normally.
    time = new Date(baseTime.getTime() + 86_400_001);
    const later = await guarded.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    expect(later.kind).toBe("created");
    if (later.kind === "created") refundIds.push(later.refundId);
    expect(submittedViaProvider).toHaveLength(1);
  });

  it("parks refunds past the documented 90-day card window (method applicability unverified locally)", async () => {
    const f = await fixture();
    time = new Date(baseTime.getTime() + 91 * 24 * 3_600_000);
    const guarded = createPaymentRefundService(database, providerStub(), { ...refundOptions, cardRefundWindowMs: 90 * 24 * 3_600_000 });
    const result = await guarded.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    expect(result).toMatchObject({ kind: "review_required", reason: "REFUND_WINDOW_METHOD_UNVERIFIED" });
    if (result.kind !== "review_required") return;
    refundIds.push(result.refundId);
    expect(submittedViaProvider).toHaveLength(0);
  });

  it("refuses refunds for payments that are not settled captures", async () => {
    const f = await fixture();
    // COD/offline-style payments never become refundable managed captures.
    const cod = await db.payment.create({ data: { orderId: f.orderId, provider: "COD", amount: 1000, status: "PAID" } });
    paymentIds.push(cod.id);
    const result = await refunds.requestRefund({ paymentId: cod.id, requestedByUserId: "admin-1" });
    expect(result).toMatchObject({ kind: "rejected", code: "NOT_REFUNDABLE" });
    const unknown = await refunds.requestRefund({ paymentId: "missing-payment", requestedByUserId: "admin-1" });
    expect(unknown).toMatchObject({ kind: "rejected", code: "PAYMENT_NOT_FOUND" });
  });

  it("refuses a refund when there is nothing left to refund", async () => {
    const f = await fixture();
    await db.payment.update({ where: { id: f.paymentId }, data: { refundedAmountMinor: f.capturedMinor } });
    const result = await refunds.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    expect(result).toMatchObject({ kind: "rejected", code: "NOTHING_TO_REFUND" });
    expect(submittedViaProvider).toHaveLength(0);
  });
});

describe("Refund submission outcomes", () => {
  it("records a definitive provider rejection as FAILED with the sanitized code", async () => {
    const f = await fixture();
    const failing = createPaymentRefundService(database,
      providerStub([{ kind: "failed", code: "HTTP_ERROR", providerMessage: "refund window exceeded" }]), refundOptions);
    const created = await failing.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(10000), requestedByUserId: "admin-1" });
    expect(created).toMatchObject({ kind: "created", submission: { kind: "failed", code: "HTTP_ERROR", message: "refund window exceeded" } });
    if (created.kind !== "created") return;
    refundIds.push(created.refundId);
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "FAILED", failureCode: "HTTP_ERROR",
      failureMessage: "refund window exceeded" });
    expect(await state(f.orderId).then(o => o.payments[0].refundedAmountMinor)).toBeNull();
  });

  it("keeps an uncertain submission PENDING for evidence-based resolution and never resubmits it", async () => {
    const f = await fixture();
    const uncertain = createPaymentRefundService(database,
      providerStub([{ kind: "uncertain", code: "TIMEOUT" }]), refundOptions);
    await quarantinePriorOpenRefunds();
    const created = await uncertain.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(10000), requestedByUserId: "admin-1" });
    expect(created).toMatchObject({ kind: "created", submission: { kind: "uncertain", code: "TIMEOUT" } });
    if (created.kind !== "created") return;
    refundIds.push(created.refundId);
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "PENDING", lastSubmissionCode: "TIMEOUT" });
    // The reconciliation sweep must NOT resubmit: it only polls the reporter.
    time = new Date(baseTime.getTime() + 10_000);
    const body = "reporter-no-refund-" + randomUUID();
    simulated.observations.set(body, { auth: null, observation: { ...reporterObservation(f, "TRACKER_ENDED"),
      kind: "CAPTURE_CONFIRMED", capturedMinor: f.capturedMinor.toString(), refundMinor: "0" } });
    const pollProvider = { fetchTracker: vi.fn(async () => ({ kind: "fetched" as const, status: 200,
      json: {}, bodyBytes: Buffer.from(body) })) };
    const sweep = await reconciliation.reconcileDueRefunds(uncertain, pollProvider,
      { environment: "sandbox", merchantAccountRef: "synthetic-account" });
    expect(sweep.considered).toBe(1);
    expect(pollProvider.fetchTracker).toHaveBeenCalledTimes(1);
    expect(sweep.outcomes[0]).toMatchObject({ refundId: created.refundId, disposition: "PENDING" });
    expect(submittedViaProvider).toHaveLength(1); // still only the original submission
  });

  it("recovers from a provider crash after the claim: the SUBMITTING row is parked, never resubmitted", async () => {
    const f = await fixture();
    // Simulate a hard adapter crash between the claim (REQUESTED → SUBMITTING) and the
    // outcome record: the row must survive as SUBMITTING and the API caller must see an
    // uncertain submission, never a fabricated rejection.
    const crashing = createPaymentRefundService(database, { submitRefund: async () => {
      throw new Error("synthetic hard crash");
    } }, refundOptions);
    await quarantinePriorOpenRefunds();
    const crashed = await crashing.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    expect(crashed).toMatchObject({ kind: "created", submission: { kind: "uncertain", code: "SUBMIT_CRASHED" } });
    if (crashed.kind !== "created") return;
    refundIds.push(crashed.refundId);
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "PENDING", lastSubmissionCode: "SUBMIT_CRASHED" });
    // A restarted worker resolves the unknown outcome through the reporter, never a resubmission.
    time = new Date(baseTime.getTime() + 200_000);
    const body = "reporter-after-crash-" + randomUUID();
    simulated.observations.set(body, { auth: null, observation: reporterObservation(f, "TRACKER_REFUNDED") });
    const restarted = createPaymentRefundService(database, providerStub(), refundOptions);
    const sweep = await reconciliation.reconcileDueRefunds(restarted,
      { fetchTracker: vi.fn(async () => ({ kind: "fetched" as const, status: 200, json: {}, bodyBytes: Buffer.from(body) })) },
      { environment: "sandbox", merchantAccountRef: "synthetic-account" });
    expect(sweep.outcomes[0]).toMatchObject({ refundId: crashed.refundId, disposition: "FINALIZED", outcome: "settled" });
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(await state(f.orderId)).toMatchObject({ paymentStatus: "REFUNDED" });
    expect(submittedViaProvider).toHaveLength(0);
  });

  it("parks a stale SUBMITTING row for review after a crash between claim and outcome record", async () => {
    const f = await fixture();
    // Seed the exact post-crash state: claimed (SUBMITTING) with an aging submittedAt.
    await quarantinePriorOpenRefunds();
    const seeded = await db.paymentRefund.create({ data: { paymentId: f.paymentId, trackerToken: f.token,
      providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account",
      amountMinor: BigInt(10000), currency: "PKR", type: "PARTIAL", status: "SUBMITTING",
      initiatedBy: "ADMIN", operationKey: "AUTO:" + randomUUID(), requestedByUserId: "admin-1",
      submittedAt: new Date(time.getTime() - 300_000) } });
    refundIds.push(seeded.id);
    time = new Date(time.getTime() + 10_000);
    const restarted = createPaymentRefundService(database, providerStub(), refundOptions);
    const sweep = await reconciliation.reconcileDueRefunds(restarted, { fetchTracker: vi.fn() },
      { environment: "sandbox", merchantAccountRef: "synthetic-account" });
    expect(sweep.outcomes[0]).toMatchObject({ refundId: seeded.id, disposition: "parked" });
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "REVIEW_REQUIRED", reviewReason: "SUBMIT_OUTCOME_UNKNOWN" });
    expect(submittedViaProvider).toHaveLength(0);
  });

  it("submits a stale REQUESTED row exactly once after a restart (crash before submission)", async () => {
    const f = await fixture();
    // Simulate a crash BEFORE the claim committed: create the row directly in REQUESTED
    // with no submission, as a restart would find it.
    const row = await db.paymentRefund.create({ data: { paymentId: f.paymentId, trackerToken: f.token,
      providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account",
      amountMinor: BigInt(10000), currency: "PKR", type: "PARTIAL", status: "REQUESTED",
      initiatedBy: "ADMIN", operationKey: "AUTO:" + randomUUID(), requestedByUserId: "admin-1" } });
    refundIds.push(row.id);
    const restarted = createPaymentRefundService(database, providerStub(), refundOptions);
    const sweep = await reconciliation.reconcileDueRefunds(restarted, { fetchTracker: vi.fn() },
      { environment: "sandbox", merchantAccountRef: "synthetic-account" });
    expect(sweep.considered).toBe(1);
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "PENDING", id: row.id });
    expect(submittedViaProvider).toEqual([{ trackerToken: f.token, amountMinor: BigInt(10000) }]);
  });

  it("finalizes a PENDING refund through reporter reconciliation after a provider timeout", async () => {
    const f = await fixture();
    const uncertain = createPaymentRefundService(database,
      providerStub([{ kind: "uncertain", code: "NETWORK_ERROR" }]), refundOptions);
    await quarantinePriorOpenRefunds();
    const created = await uncertain.requestRefund({ paymentId: f.paymentId, requestedByUserId: "admin-1" });
    if (created.kind !== "created") throw new Error("expected created");
    refundIds.push(created.refundId);
    time = new Date(baseTime.getTime() + 10_000);
    const body = "reporter-refunded-" + randomUUID();
    simulated.observations.set(body, { auth: null, observation: reporterObservation(f, "TRACKER_REFUNDED") });
    const pollProvider = { fetchTracker: vi.fn(async () => ({ kind: "fetched" as const, status: 200,
      json: {}, bodyBytes: Buffer.from(body) })) };
    const sweep = await reconciliation.reconcileDueRefunds(uncertain, pollProvider,
      { environment: "sandbox", merchantAccountRef: "synthetic-account" });
    expect(sweep.considered).toBe(1);
    expect(sweep.outcomes[0]).toMatchObject({ refundId: created.refundId, disposition: "FINALIZED", outcome: "settled" });
    expect((await rows(f.paymentId))[0]).toMatchObject({ status: "SUCCEEDED" });
    expect(await state(f.orderId)).toMatchObject({ paymentStatus: "REFUNDED" });
  });

  it("exhausts bounded confirmation attempts for a missing webhook into REVIEW_REQUIRED", async () => {
    const f = await fixture();
    await quarantinePriorOpenRefunds();
    const created = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(10000), requestedByUserId: "admin-1" });
    if (created.kind !== "created") throw new Error("expected created");
    refundIds.push(created.refundId);
    const body = "reporter-still-captured-" + randomUUID();
    simulated.observations.set(body, { auth: null, observation: { ...reporterObservation(f, "TRACKER_ENDED"),
      kind: "CAPTURE_CONFIRMED", capturedMinor: f.capturedMinor.toString(), refundMinor: "0" } });
    const pollProvider = { fetchTracker: vi.fn(async () => ({ kind: "fetched" as const, status: 200,
      json: {}, bodyBytes: Buffer.from(body) })) };
    for (let round = 0; round < 4; round++) {
      time = new Date(time.getTime() + 2_000);
      const sweep = await reconciliation.reconcileDueRefunds(refunds, pollProvider,
        { environment: "sandbox", merchantAccountRef: "synthetic-account" });
      if (sweep.considered === 0) break;
    }
    const row = (await rows(f.paymentId))[0];
    expect(row).toMatchObject({ status: "REVIEW_REQUIRED", reviewReason: "CONFIRMATION_TIMEOUT" });
    expect(submittedViaProvider).toHaveLength(1); // exactly one submission ever
    expect(await state(f.orderId).then(o => o.payments[0].refundedAmountMinor)).toBeNull();
  });

  it("never resubmits a PENDING refund during sweeps (missing-webhook case stays bounded)", async () => {
    const f = await fixture();
    await quarantinePriorOpenRefunds();
    const created = await refunds.requestRefund({ paymentId: f.paymentId, amountMinor: BigInt(10000), requestedByUserId: "admin-1" });
    if (created.kind !== "created") throw new Error("expected created");
    refundIds.push(created.refundId);
    const body = "reporter-empty-" + randomUUID();
    simulated.observations.set(body, { auth: null, observation: { ...reporterObservation(f, "TRACKER_ENDED"),
      kind: "CAPTURE_CONFIRMED", capturedMinor: f.capturedMinor.toString(), refundMinor: "0" } });
    const pollProvider = { fetchTracker: vi.fn(async () => ({ kind: "fetched" as const, status: 200,
      json: {}, bodyBytes: Buffer.from(body) })) };
    for (let round = 0; round < 3; round++) {
      time = new Date(time.getTime() + 2_000);
      await reconciliation.reconcileDueRefunds(refunds, pollProvider,
        { environment: "sandbox", merchantAccountRef: "synthetic-account" });
    }
    expect(submittedViaProvider).toHaveLength(1);
    expect((await rows(f.paymentId))[0].status).toBe("REVIEW_REQUIRED");
  });
});
