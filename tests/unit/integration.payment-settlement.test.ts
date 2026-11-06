import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../generated/postgres-client";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const simulated = vi.hoisted(() => ({ enabled: true,
  observations: new Map<string, { auth: string; observation: unknown }>() }));
// The only approved adapter in these tests is a module mock. Application code contains no simulation switch.
vi.mock("@/lib/payments/verification-registry", () => ({ PAYMENT_PROVIDER_VERIFICATION_ENABLED: false,
  approvedPaymentVerifier: (input: { provider: string; channel: string; environment: string; merchantAccountRef: string }) =>
    !simulated.enabled ? null : { provider: input.provider, channel: input.channel, environment: input.environment,
      merchantAccountRef: input.merchantAccountRef, merchantIdentity: "SIMULATED_MERCHANT", contractVersion: "SIMULATED_ONLY_V1",
      retainedHeaderNames: ["x-simulated-proof"], verify: async (request: { body: Uint8Array; headers: Record<string, string> }) => {
        const row = simulated.observations.get(new TextDecoder().decode(request.body));
        return row && request.headers["x-simulated-proof"] === row.auth ?
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
import { createSafepayReservationService } from "@/services/safepay-reservations.service";
import { createPaymentSettlementService, type PaymentPersistence } from "@/services/payment-settlement.service";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { authenticatePaymentEvidence } from "@/lib/payments/verified-evidence";
import { trackerIdentity, type PaymentObservation, type VerificationInput } from "@/lib/payments/evidence-contract";
import { adminUpdateOrderStatus } from "@/services/orders.service";
import { DEFAULT_SETTINGS } from "@/services/settings.service";
import { placeOrder } from "@/services/checkout.service";
import * as cartService from "@/services/cart.service";
import * as settingsService from "@/services/settings.service";

assertDisposableTestDatabase();
const database = db as unknown as PaymentPersistence;
const baseTime = new Date("2026-11-05T20:00:00.000Z"); let time = new Date(baseTime);
const clock = () => new Date(time);
const options = { now: clock, reconcileDelayMs: 60_000 };
const key = randomBytes(32), vault = createPaymentPayloadVault("synthetic-key", new Map([["synthetic-key", key]]));
const inbox = createPaymentWebhookService(database, vault, options);
const settlement = createPaymentSettlementService(database, options);
const reconciliation = createPaymentReconciliationService(database, inbox, clock);
const reservations = createSafepayReservationService(database, clock);
const settings = { ...DEFAULT_SETTINGS, bank_transfer_enabled: true };
const productIds: string[] = [], categoryIds: string[] = [], cartIds: string[] = [], couponIds: string[] = [], userIds: string[] = [], eventIds: string[] = [];
function checkoutInput(method: "ONLINE" | "COD" | "BANK_TRANSFER" = "ONLINE", couponCode?: string) {
  return { idempotencyKey: randomUUID(), paymentMethod: method, deliveryMethod: "STANDARD" as const,
    customer: { name: "Synthetic Buyer", email: "synthetic@example.invalid", phone: "03001234567" },
    address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" }, couponCode };
}
async function fixture(opts: { coupon?: boolean; multi?: boolean } = {}) {
  const category = await db.category.create({ data: { name: "Synthetic " + randomUUID(), slug: randomUUID() } }); categoryIds.push(category.id);
  const products: Array<Prisma.ProductGetPayload<{ include: { inventory: true } }>> = [];
  for (let i = 0; i < (opts.multi ? 2 : 1); i++) {
    const product = await db.product.create({ data: { name: "Synthetic settlement item", slug: randomUUID(), categoryId: category.id,
      price: 1000, status: "PUBLISHED", inventory: { create: { quantity: 5 } } }, include: { inventory: true } });
    products.push(product); productIds.push(product.id);
  }
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid" } });
  userIds.push(user.id);
  const owner = { kind: "USER" as const, userId: user.id };
  const cart = await db.cart.create({ data: { userId: user.id,
    items: { create: products.map(p => ({ productId: p.id, quantity: 1 })) } } }); cartIds.push(cart.id);
  let coupon: Awaited<ReturnType<typeof db.coupon.create>> | null = null;
  if (opts.coupon) { coupon = await db.coupon.create({ data: { code: "C" + randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase(),
    type: "PERCENT", value: 10, maxUses: 2 } }); couponIds.push(coupon.id); }
  const context = { cartId: cart.id, owner };
  const run = createSafepayPendingOrderService({ database, getSettings: async () => settings, environment: "sandbox",
    merchantAccountRef: "synthetic-account", reservationTtlMs: 600_000, now: clock });
  const prepared = await run(checkoutInput("ONLINE", coupon?.code), context);
  if (prepared.kind !== "ready") throw new Error("Synthetic pending order failed: " + prepared.code);
  const token = "synthetic-tracker-" + randomUUID();
  // Synthetic tracker binding only. No provider adapter, fetch or API transaction is executed.
  await db.payment.update({ where: { id: prepared.paymentId }, data: { trackerToken: token,
    trackerIdentityKey: trackerIdentity({ provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account", trackerToken: token }),
    creationStartedAt: time, trackerBoundAt: time, attemptState: "CHECKOUT_ISSUED", reconcileStatus: "PENDING" } });
  const payment = await db.payment.findUniqueOrThrow({ where: { id: prepared.paymentId } });
  const observation: PaymentObservation = { provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    merchantIdentity: "SIMULATED_MERCHANT", observationId: randomUUID(), orderId: prepared.orderId, paymentId: prepared.paymentId,
    attemptNumber: 1, trackerToken: token, owner: bindCheckoutOwner(owner), currency: "PKR",
    amountMinor: payment.expectedAmountMinor!.toString(), kind: "CAPTURE_CONFIRMED", capturedMinor: payment.expectedAmountMinor!.toString(),
    refundMinor: null, occurredAt: time.toISOString() };
  return { ...prepared, products, context, coupon, observation, payment };
}
function authenticatedInput(observation: PaymentObservation, channel: "WEBHOOK" | "RECONCILIATION" = "WEBHOOK"): VerificationInput {
  const body = JSON.stringify({ syntheticObservation: randomUUID() }), auth = randomUUID();
  simulated.observations.set(body, { auth, observation });
  return { provider: observation.provider, environment: observation.environment, merchantAccountRef: observation.merchantAccountRef,
    channel, body: Buffer.from(body), headers: { "x-simulated-proof": auth } };
}
async function receive(observation: PaymentObservation, service = inbox, channel: "WEBHOOK" | "RECONCILIATION" = "WEBHOOK") {
  const input = authenticatedInput(observation, channel), result = await service.receive(input);
  if (!("eventId" in result)) throw new Error("Synthetic inbox failed");
  eventIds.push(result.eventId); return { ...result, input };
}
async function processObservation(observation: PaymentObservation, service = inbox) {
  const received = await receive(observation, service); return service.process(received.eventId);
}
async function state(id: string) { return db.order.findUniqueOrThrow({ where: { id }, include: { payments: true,
  items: { include: { inventoryReservation: true } }, couponReservation: true } }); }
async function quantities(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all(f.products.map(async p => (await db.inventory.findUniqueOrThrow({ where: { productId: p.id } })).quantity));
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
beforeEach(() => { time = new Date(baseTime); simulated.enabled = true; vi.restoreAllMocks(); });
afterAll(async () => {
  const orders = (await db.order.findMany({ where: { items: { some: { productId: { in: productIds } } } }, select: { id: true } })).map(o => o.id);
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.paymentWebhookEvent.deleteMany({ where: { OR: [{ id: { in: eventIds } }, { payment: { orderId: { in: orders } } }] } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await db.couponReservation.deleteMany({ where: { orderId: { in: orders } } });
  await db.order.updateMany({ where: { id: { in: orders } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orders } } }); await db.cart.deleteMany({ where: { id: { in: cartIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } }); await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  await db.coupon.deleteMany({ where: { id: { in: couponIds } } }); await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("Authenticated settlement with simulated verified observations", () => {
  it.each([{ user: false, coupon: false }, { user: true, coupon: false }, { user: false, coupon: true }, { user: true, coupon: true }])(
    "settles one order atomically with exact server amounts: %j", async opts => {
      const f = await fixture({ ...opts, multi: true }); expect(await processObservation(f.observation)).toEqual({ kind: "settled" });
      const order = await state(f.orderId);
      expect(order).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID", acceptedPaymentId: f.paymentId, paymentReviewStatus: "CLEAR" });
      expect(order.payments[0]).toMatchObject({ status: "PAID", attemptState: "SETTLED", reconcileStatus: "VERIFIED",
        capturedAmountMinor: BigInt(f.observation.amountMinor) });
      expect(order.items.every(i => i.inventoryReservation?.state === "CONSUMED")).toBe(true);
      expect(await quantities(f)).toEqual([4, 4]);
      if (f.coupon) {
        expect(order.couponReservation?.state).toBe("COMMITTED");
        expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon.id } })).toMatchObject({ reservedCount: 0, usedCount: 1 });
      }
      expect(await adminUpdateOrderStatus(f.orderId, "PROCESSING")).toEqual({ ok: true });
      expect(await quantities(f)).toEqual([4, 4]);
    });
  it("deduplicates redeliveries and processes one final evidence record", async () => {
    const f = await fixture({ coupon: true }), received = await receive(f.observation);
    expect(await inbox.receive(received.input)).toMatchObject({ kind: "duplicate", eventId: received.eventId });
    expect(await inbox.process(received.eventId)).toEqual({ kind: "settled" });
    expect(await inbox.process(received.eventId)).toEqual({ kind: "duplicate" });
    expect(await inbox.receive(received.input)).toMatchObject({ kind: "duplicate" });
    expect(await db.paymentWebhookEvent.findUniqueOrThrow({ where: { id: received.eventId } })).toMatchObject({ deliveryCount: 3 });
    expect(await db.paymentEvidence.count({ where: { processedWebhookEventId: received.eventId } })).toBe(1);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 0, usedCount: 1 });
  });
  it("does not repeat capture for a new observation ID or regress fulfilled status", async () => {
    const f = await fixture({ coupon: true }); expect(await processObservation(f.observation)).toEqual({ kind: "settled" });
    expect(await adminUpdateOrderStatus(f.orderId, "PROCESSING")).toEqual({ ok: true });
    expect(await adminUpdateOrderStatus(f.orderId, "SHIPPED")).toEqual({ ok: true });
    expect(await processObservation({ ...f.observation, observationId: randomUUID() })).toEqual({ kind: "already_settled" });
    expect((await state(f.orderId)).status).toBe("SHIPPED"); expect(await quantities(f)).toEqual([4]);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 0, usedCount: 1 });
  });
  it("keeps settled capture idempotent after a permitted coupon rename", async () => {
    const f = await fixture({ coupon: true }); expect(await processObservation(f.observation)).toEqual({ kind: "settled" });
    await db.coupon.update({ where: { id: f.coupon!.id }, data: { code: "RENAMED" + randomUUID().replaceAll("-", "").slice(0, 10) } });
    expect(await processObservation({ ...f.observation, observationId: randomUUID() })).toEqual({ kind: "already_settled" });
    expect((await state(f.orderId)).paymentReviewStatus).toBe("CLEAR");
    expect(await quantities(f)).toEqual([4]);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 0, usedCount: 1 });
  });
  it.each([{}, { verified: true }, { authenticated: true, kind: "CAPTURE_CONFIRMED" }, null])("hard-rejects plain evidence %j", async fake => {
    const f = await fixture(), event = await receive(f.observation);
    expect(await settlement.apply(fake, event.eventId)).toEqual({ kind: "blocked", code: "UNTRUSTED_EVIDENCE" });
    expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
  });
  it("rejects serialized/copied proofs and proof-to-event substitution", async () => {
    const f = await fixture(), other = await fixture(), event = await receive(f.observation), otherEvent = await receive(other.observation);
    const result = await authenticatePaymentEvidence(event.input, time); if (result.kind !== "verified") throw new Error("Expected simulated proof");
    for (const fake of [{ ...result.proof }, JSON.parse(JSON.stringify(result.proof))])
      expect(await settlement.apply(fake, event.eventId)).toEqual({ kind: "blocked", code: "UNTRUSTED_EVIDENCE" });
    expect(await settlement.apply(result.proof, otherEvent.eventId)).toEqual({ kind: "blocked", code: "EVENT_BINDING" });
    expect((await state(other.orderId)).paymentStatus).toBe("PENDING");
    time = new Date(baseTime.getTime() + 300_001);
    expect(await settlement.apply(result.proof, event.eventId)).toEqual({ kind: "blocked", code: "UNTRUSTED_EVIDENCE" });
  });
  it("quarantines events when verification is disabled, even with a simulated success body", async () => {
    const f = await fixture(); simulated.enabled = false;
    const event = await receive(f.observation); expect(event.kind).toBe("quarantined");
    expect(await inbox.process(event.eventId)).toEqual({ kind: "review_required" });
    expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
  });
  it("reauthenticates a durable event after verifier approval was revoked", async () => {
    const f = await fixture(), event = await receive(f.observation); simulated.enabled = false;
    expect(await inbox.process(event.eventId)).toEqual({ kind: "blocked", code: "VERIFICATION_DISABLED" });
    expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
  });
  it("rejects missing authentication and encrypts the original immutable body", async () => {
    const f = await fixture(), event = await receive(f.observation);
    const row = await db.paymentWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } });
    expect(Buffer.from(row.payloadCiphertext!).toString()).not.toContain(new TextDecoder().decode(event.input.body));
    expect(row.signatureValue).toBeNull(); expect(row.payloadKeyId).toBe("synthetic-key");
    const invalid = await inbox.receive({ ...event.input, headers: {} });
    if (!("eventId" in invalid)) throw new Error("Expected quarantine"); eventIds.push(invalid.eventId);
    expect(invalid.kind).toBe("quarantined");
    await db.paymentWebhookEvent.update({ where: { id: event.eventId }, data: { payloadAuthTag: randomBytes(16) } });
    expect((await inbox.process(event.eventId)).kind).toBe("blocked");
    expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
  });
  it.each(["order", "payment", "attempt", "tracker", "owner", "currency", "merchant", "environment", "provider"])("rejects a bound identity mismatch: %s", async field => {
    const f = await fixture(), other = await fixture();
    const o = { ...f.observation, ...(field === "order" ? { orderId: other.orderId } :
      field === "payment" ? { paymentId: other.paymentId } : field === "attempt" ? { attemptNumber: 2 } : field === "tracker" ? { trackerToken: "different-tracker" } :
      field === "owner" ? { owner: bindCheckoutOwner(other.context.owner) } : field === "currency" ? { currency: "USD" } :
      field === "merchant" ? { merchantAccountRef: "other-account" } : field === "environment" ? { environment: "production" as const } : { provider: "OTHER" }) };
    const before = await state(f.orderId); expect(await processObservation(o)).toEqual({ kind: "blocked", code: "IDENTITY_MISMATCH" });
    expect(await state(f.orderId)).toEqual(before); expect((await state(other.orderId)).paymentStatus).toBe("PENDING");
    expect(await quantities(f)).toEqual([4]);
  });
  it("does not accept a merchant identity that the approved verifier has not established", async () => {
    const f = await fixture(), event = await receive({ ...f.observation, merchantIdentity: "UNESTABLISHED" });
    expect(event.kind).toBe("quarantined"); expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
  });
  it.each(["1", "99999999", "1100"])("holds an incorrect exact minor amount %s for review", async amountMinor => {
    const f = await fixture({ coupon: true });
    expect(await processObservation({ ...f.observation, amountMinor, capturedMinor: amountMinor })).toEqual({ kind: "review_required" });
    const order = await state(f.orderId); expect(order).toMatchObject({ paymentStatus: "PENDING", paymentReviewStatus: "REQUIRED" });
    expect(order.items[0].inventoryReservation?.state).toBe("HELD"); expect(order.couponReservation?.state).toBe("HELD");
  });
  it.each(["-1", "1.2", "1e5", "9223372036854775808"])("quarantines noncanonical/out-of-range amounts %s", async amountMinor => {
    const f = await fixture(); expect((await receive({ ...f.observation, amountMinor })).kind).toBe("quarantined");
    expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
  });
  it("requires confirmed capture amount to match the full quote and rejects a refund mixed with capture", async () => {
    for (const changes of [{ capturedMinor: "1" }, { refundMinor: "1" }]) {
      const f = await fixture(); expect(await processObservation({ ...f.observation, ...changes })).toEqual({ kind: "review_required" });
      expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
    }
  });
  it.each(["missing", "released", "quantity", "snapshot", "coupon-counter"])("does not consume inconsistent reservations: %s", async change => {
    const f = await fixture({ coupon: true }), order = await state(f.orderId);
    const hold = order.items[0].inventoryReservation!;
    if (change === "missing") await db.inventoryReservation.delete({ where: { id: hold.id } });
    if (change === "released") await db.inventoryReservation.update({ where: { id: hold.id }, data: { state: "RELEASED", releasedAt: time } });
    if (change === "quantity") await db.inventoryReservation.update({ where: { id: hold.id }, data: { quantity: 2 } });
    if (change === "snapshot") await db.order.update({ where: { id: f.orderId }, data: { subtotal: 1 } });
    if (change === "coupon-counter") await db.coupon.update({ where: { id: f.coupon!.id }, data: { reservedCount: 0 } });
    expect(await processObservation(f.observation)).toEqual({ kind: "review_required" });
    expect((await state(f.orderId)).paymentStatus).toBe("PENDING"); expect(await quantities(f)).toEqual([4]);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).usedCount).toBe(0);
  });
  it("does not accept capture from a replaced attempt or an order already under review", async () => {
    for (const change of ["replacement", "review"]) {
      const f = await fixture();
      if (change === "review") await db.order.update({ where: { id: f.orderId }, data: { paymentReviewStatus: "REQUIRED" } });
      else {
        const replacement = await db.payment.create({ data: { orderId: f.orderId, provider: "SAFEPAY", amount: f.payment.amount,
          attemptNumber: 2, attemptState: "READY", providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account",
          currency: "PKR", expectedAmountMinor: f.payment.expectedAmountMinor } });
        await db.order.update({ where: { id: f.orderId }, data: { activePaymentId: replacement.id } });
      }
      expect(await processObservation(f.observation)).toEqual({ kind: "review_required" }); expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
    }
  });
});

describe("Inbox replay, reconciliation, races and atomic rollback", () => {
  it("deduplicates concurrent deliveries using independent clients", async () => {
    const { PrismaClient } = await import("../../generated/sqlite-client");
    const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
      const f = await fixture({ coupon: true }), request = authenticatedInput(f.observation);
      const otherInbox = createPaymentWebhookService(other as unknown as PaymentPersistence, vault, options);
      const receipts = await Promise.all([inbox.receive(request), otherInbox.receive(request)]);
      const ids = receipts.flatMap(r => "eventId" in r ? [r.eventId] : []); eventIds.push(...ids);
      expect(new Set(ids).size).toBe(1);
      const results = await Promise.all([inbox.process(ids[0]), otherInbox.process(ids[0])]);
      expect(results.some(r => r.kind === "settled")).toBe(true);
      expect(await db.paymentEvidence.count({ where: { processedWebhookEventId: ids[0] } })).toBe(1);
      expect((await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).usedCount).toBe(1);
    } finally { await other.$disconnect(); }
  });
  it("settles concurrent webhook and reconciliation evidence only once", async () => {
    const f = await fixture({ coupon: true });
    const webhook = await receive(f.observation), lookup = await receive({ ...f.observation, observationId: randomUUID() }, inbox, "RECONCILIATION");
    const results = await Promise.all([inbox.process(webhook.eventId), inbox.process(lookup.eventId)]);
    expect(results.filter(r => r.kind === "settled")).toHaveLength(1);
    expect(await quantities(f)).toEqual([4]); expect((await state(f.orderId)).couponReservation?.state).toBe("COMMITTED");
    expect((await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).usedCount).toBe(1);
  });
  it("detects reuse of an authenticated event identity with altered business facts", async () => {
    const f = await fixture({ coupon: true }), first = await receive(f.observation);
    expect(await inbox.process(first.eventId)).toEqual({ kind: "settled" });
    const conflicting = await receive({ ...f.observation, capturedMinor: "1" });
    expect(conflicting).toMatchObject({ kind: "conflict", eventId: first.eventId });
    expect(await inbox.process(first.eventId)).toEqual({ kind: "review_required" });
    const order = await state(f.orderId); expect(order).toMatchObject({ paymentStatus: "PAID", paymentReviewStatus: "REQUIRED" });
    expect((await adminUpdateOrderStatus(f.orderId, "PROCESSING")).ok).toBe(false);
    expect(await quantities(f)).toEqual([4]); expect((await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).usedCount).toBe(1);
    expect(await db.paymentEvidence.count({ where: { processedWebhookEventId: first.eventId } })).toBe(1);
  });
  it("quarantines a conflicting identity before either body can settle", async () => {
    const f = await fixture(), first = await receive(f.observation);
    expect((await receive({ ...f.observation, amountMinor: "1" })).kind).toBe("conflict");
    expect(await inbox.process(first.eventId)).toEqual({ kind: "review_required" });
    expect((await state(f.orderId)).paymentStatus).toBe("PENDING");
  });
  it.each(["PENDING", "UNCERTAIN", "FAILURE_CONFIRMED", "REVIEW_REQUIRED"] as const)("records trusted internal reconciliation %s without releasing holds", async kind => {
    const f = await fixture({ coupon: true });
    const request = authenticatedInput({ ...f.observation, kind, capturedMinor: null }, "RECONCILIATION");
    const result = await reconciliation.observe(request);
    expect(result.kind).toBe(kind === "PENDING" || kind === "UNCERTAIN" ? "recorded" : "review_required");
    const order = await state(f.orderId);
    expect(order.paymentStatus).toBe("PENDING"); expect(order.payments[0].status).toBe("PENDING");
    expect(order.payments[0].reconcileStatus).toBe(kind === "FAILURE_CONFIRMED" ? "FAILED" : kind);
    expect(order.items[0].inventoryReservation?.state).toBe("HELD"); expect(order.couponReservation?.state).toBe("HELD");
    expect(await quantities(f)).toEqual([4]);
  });
  it("lets a verified capture resolve a pending/uncertain observation, without provider status guesses", async () => {
    const f = await fixture();
    const received = await receive({ ...f.observation, kind: "UNCERTAIN", capturedMinor: null });
    expect(await inbox.process(received.eventId)).toEqual({ kind: "recorded" });
    expect(await processObservation({ ...f.observation, observationId: randomUUID() })).toEqual({ kind: "settled" });
  });
  it.each(["PENDING", "UNCERTAIN"] as const)("ignores out-of-order %s after capture", async kind => {
    const f = await fixture(); expect(await processObservation(f.observation)).toEqual({ kind: "settled" });
    expect(await processObservation({ ...f.observation, observationId: randomUUID(), kind, capturedMinor: null })).toEqual({ kind: "recorded" });
    expect((await state(f.orderId)).payments[0]).toMatchObject({ status: "PAID", reconcileStatus: "VERIFIED" });
  });
  it("holds a failure after capture for review and never reverses settlement", async () => {
    const f = await fixture(); await processObservation(f.observation);
    expect(await processObservation({ ...f.observation, observationId: randomUUID(), kind: "FAILURE_CONFIRMED", capturedMinor: null })).toEqual({ kind: "review_required" });
    expect((await state(f.orderId)).payments[0]).toMatchObject({ status: "PAID", reconcileStatus: "REVIEW_REQUIRED" });
    expect(await quantities(f)).toEqual([4]);
  });
  it("does not silently ignore financial amounts on a stale pending observation", async () => {
    const f = await fixture(); await processObservation(f.observation);
    expect(await processObservation({ ...f.observation, observationId: randomUUID(), kind: "PENDING", capturedMinor: null,
      refundMinor: "1" })).toEqual({ kind: "review_required" });
    expect((await state(f.orderId)).payments[0]).toMatchObject({ status: "PAID", reconcileStatus: "REVIEW_REQUIRED" });
    expect(await quantities(f)).toEqual([4]);
  });
  it.each(["1", "110000", "999999999"])("records refund notice %s for review without assuming full/partial/cumulative semantics", async refundMinor => {
    const f = await fixture({ coupon: true }); await processObservation(f.observation);
    expect(await processObservation({ ...f.observation, observationId: randomUUID(), kind: "REFUND_NOTICE", refundMinor })).toEqual({ kind: "review_required" });
    const order = await state(f.orderId); expect(order).toMatchObject({ paymentStatus: "PAID", paymentReviewStatus: "REQUIRED" });
    expect(order.payments[0].refundedAmountMinor).toBeNull(); expect(order.items[0].inventoryReservation?.state).toBe("CONSUMED");
    expect(await quantities(f)).toEqual([4]);
  });
  it.each(["cancel", "expire"])("holds late success after %s for review", async action => {
    const f = await fixture({ coupon: true });
    if (action === "cancel") await reservations.cancel(f.orderId, f.context.owner);
    else { time = new Date(baseTime.getTime() + 600_001); await reservations.expireBatch(100); }
    expect(await processObservation(f.observation)).toEqual({ kind: "review_required" });
    const order = await state(f.orderId); expect(order).toMatchObject({ status: "CANCELLED", paymentStatus: "PENDING", acceptedPaymentId: null });
    expect(order.items[0].inventoryReservation?.state).toBe("HELD"); expect(await quantities(f)).toEqual([4]);
  });
  it("does not settle after the local deadline even if expiration has not run", async () => {
    const f = await fixture(); time = new Date(baseTime.getTime() + 600_001);
    expect(await processObservation(f.observation)).toEqual({ kind: "review_required" });
    expect((await state(f.orderId)).items[0].inventoryReservation?.state).toBe("HELD");
  });
  it("rolls back consumption when settlement crosses the reservation deadline", async () => {
    const f = await fixture({ coupon: true }), event = await receive(f.observation);
    await db.order.update({ where: { id: f.orderId }, data: { reservationExpiresAt: new Date(baseTime.getTime() + 1000) } });
    const authenticated = await authenticatePaymentEvidence(event.input, baseTime);
    if (authenticated.kind !== "verified") throw new Error("Expected synthetic proof");
    let calls = 0;
    const crossing = createPaymentSettlementService(database, { reconcileDelayMs: 1000,
      now: () => new Date(baseTime.getTime() + (calls++ ? 1001 : 0)) });
    expect(await crossing.apply(authenticated.proof, event.eventId)).toEqual({ kind: "review_required" });
    const order = await state(f.orderId); expect(order.paymentStatus).toBe("PENDING");
    expect(order.items[0].inventoryReservation?.state).toBe("HELD"); expect(await quantities(f)).toEqual([4]);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 1 });
  });
  it("serializes cancellation against settlement and never restores a potentially payable hold", async () => {
    const f = await fixture({ coupon: true }), event = await receive(f.observation);
    await Promise.all([inbox.process(event.eventId), reservations.cancel(f.orderId, f.context.owner)]);
    const order = await state(f.orderId); expect(await quantities(f)).toEqual([4]);
    const coupon = await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } });
    if (order.paymentStatus === "PAID") {
      expect(order.status).toBe("CONFIRMED"); expect(order.items[0].inventoryReservation?.state).toBe("CONSUMED");
      expect(coupon).toMatchObject({ usedCount: 1, reservedCount: 0 });
    } else {
      expect(order.status).toBe("CANCELLED"); expect(order.items[0].inventoryReservation?.state).toBe("HELD");
      expect(coupon).toMatchObject({ usedCount: 0, reservedCount: 1 });
    }
  });
  it("serializes expiration, reconciliation and settlement without releasing ambiguous stock", async () => {
    const f = await fixture({ coupon: true }), event = await receive(f.observation);
    time = new Date(baseTime.getTime() + 600_001);
    await Promise.all([inbox.process(event.eventId), reservations.expireBatch(100),
      reconciliation.observe(authenticatedInput({ ...f.observation, observationId: randomUUID(), kind: "PENDING", capturedMinor: null }, "RECONCILIATION"))]);
    const order = await state(f.orderId); expect(order.paymentStatus).toBe("PENDING");
    expect(order.items[0].inventoryReservation?.state).toBe("HELD"); expect(await quantities(f)).toEqual([4]);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 1 });
  });
  it.each([["couponReservation", "updateMany", 1], ["inventoryReservation", "updateMany", 2], ["payment", "updateMany", 1],
    ["order", "update", 1], ["paymentWebhookEvent", "updateMany", 1], ["paymentEvidence", "create", 1]] as const)(
    "rolls back all settlement effects if %s.%s fails", async (model, operation, failAt) => {
      const f = await fixture({ coupon: true, multi: true }), event = await receive(f.observation);
      const broken = createPaymentWebhookService(failingDatabase(model, operation, failAt), vault, options);
      expect(await broken.process(event.eventId)).toEqual({ kind: "blocked", code: "PERSISTENCE_UNAVAILABLE" });
      const order = await state(f.orderId); expect(order).toMatchObject({ status: "PENDING", paymentStatus: "PENDING", acceptedPaymentId: null });
      expect(order.payments[0].status).toBe("PENDING"); expect(order.items.every(i => i.inventoryReservation?.state === "HELD")).toBe(true);
      expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 1 });
      expect(await db.paymentWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } })).toMatchObject({ processedAt: null, processingStatus: "RECEIVED" });
      expect(await db.paymentEvidence.count({ where: { processedWebhookEventId: event.eventId } })).toBe(0);
      expect(await inbox.process(event.eventId)).toEqual({ kind: "settled" });
      expect(await quantities(f)).toEqual([4, 4]);
    });
  it("discovers bounded pending inbox/reconciliation work and respects a local retry delay", async () => {
    const f = await fixture(), event = await receive(f.observation);
    expect((await inbox.pending(100)).some(row => row.id === event.eventId)).toBe(true);
    const pendingEvent = await receive({ ...f.observation, observationId: randomUUID(), kind: "UNCERTAIN", capturedMinor: null });
    await inbox.process(pendingEvent.eventId);
    expect((await reconciliation.due(100)).some(row => row.id === f.paymentId)).toBe(false);
    time = new Date(baseTime.getTime() + 60_001);
    expect((await reconciliation.due(100)).some(row => row.id === f.paymentId)).toBe(true);
    expect((await reconciliation.observe(event.input)).kind).toBe("blocked"); // Browser/webhook channel is not a lookup response.
    expect(await inbox.process(event.eventId)).toEqual({ kind: "settled" });
    expect((await reconciliation.due(100)).some(row => row.id === f.paymentId)).toBe(false);
    for (const limit of [0, 101, 1.5]) {
      await expect(inbox.pending(limit)).rejects.toThrow(); await expect(reconciliation.due(limit)).rejects.toThrow();
    }
  });
  it.each(["COD", "BANK_TRANSFER"] as const)("preserves %s checkout/cancellation beside settled Safepay stock", async method => {
    const f = await fixture({ coupon: true }); await processObservation(f.observation);
    vi.spyOn(settingsService, "getSettings").mockResolvedValue(settings);
    const product = f.products[0];
    vi.spyOn(cartService, "getCartDetails").mockResolvedValue({ id: "mock-offline-cart", subtotal: 1000, itemCount: 1, wrappedUnits: 0,
      items: [{ itemId: "mock-line", productId: product.id, name: product.name, slug: product.slug, price: 1000, comparePrice: null,
        image: null, quantity: 1, stock: 4, lowStock: true, outOfStock: false, lineTotal: 1000, giftWrap: false, priceChanged: false }] });
    vi.spyOn(cartService, "clearCart").mockResolvedValue(undefined);
    const placed = await placeOrder(checkoutInput(method), f.context.owner.userId);
    if (!placed.ok) throw new Error("Offline checkout failed");
    expect((await state(placed.orderId)).paymentFlowVersion).toBeNull(); expect(await quantities(f)).toEqual([3]);
    expect(await adminUpdateOrderStatus(placed.orderId, "CANCELLED")).toEqual({ ok: true });
    expect(await quantities(f)).toEqual([4]); expect((await state(f.orderId)).paymentStatus).toBe("PAID");
  });
});
