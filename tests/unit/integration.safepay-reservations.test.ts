import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import type { Coupon, Prisma } from "../../generated/postgres-client";

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return { db: new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }) };
});
import { db } from "@/lib/db";
import { createSafepayPendingOrderService, type TrustedPendingCheckout } from "@/services/safepay-pending-order.service";
import { createSafepayReservationService } from "@/services/safepay-reservations.service";
import { createPrismaSafepayStore, bindCheckoutOwner, type PaymentDatabase } from "@/services/safepay-attempt.store";
import { adminUpdateOrderStatus } from "@/services/orders.service";
import { adminUpdateInventory } from "@/services/inventory.service";
import { adminUpdateProduct } from "@/services/products.service";
import { adminUpdateCoupon, adminDeleteCoupon, reserveCoupon, validateCoupon } from "@/services/promotions.service";
import { DEFAULT_SETTINGS } from "@/services/settings.service";
import { placeOrder } from "@/services/checkout.service";
import { loadSafepayConfig } from "@/lib/safepay/config";
import * as cartService from "@/services/cart.service";
import * as settingsService from "@/services/settings.service";

assertDisposableTestDatabase();
const database = db as unknown as PaymentDatabase;
const productIds: string[] = [], categoryIds: string[] = [], couponIds: string[] = [], cartIds: string[] = [], userIds: string[] = [];
const baseTime = new Date("2026-11-05T12:00:00.000Z");
let time = new Date(baseTime);
const clock = () => new Date(time);
const settings = { ...DEFAULT_SETTINGS, delivery_fee_standard: 200, gift_wrap_charge: 150 };
const config = loadSafepayConfig({ SAFEPAY_ENVIRONMENT: "sandbox", SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public", SAFEPAY_SECRET_KEY: "synthetic-secret",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-independent-return-secret-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account", SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid" });
function makeService(customDatabase = database) {
  return createSafepayPendingOrderService({ database: customDatabase, getSettings: async () => settings,
    environment: "sandbox", merchantAccountRef: "synthetic-account", reservationTtlMs: 600_000, now: clock });
}
const pending = makeService();
const reservations = createSafepayReservationService(database, clock);
const input = (couponCode?: string) => ({ idempotencyKey: randomUUID(), paymentMethod: "ONLINE" as const,
  deliveryMethod: "STANDARD" as const, customer: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "03001234567" },
  address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" },
  ...(couponCode ? { couponCode } : {}) });

async function fixture(options: { stock?: number; quantity?: number; coupon?: boolean; giftWrap?: boolean } = {}) {
  const category = await db.category.create({ data: { name: "Synthetic " + randomUUID(), slug: randomUUID() } });
  categoryIds.push(category.id);
  const product = await db.product.create({ data: { name: "Synthetic watch", slug: randomUUID(), categoryId: category.id,
    status: "PUBLISHED", price: 1000, inventory: { create: { quantity: options.stock ?? 5 } },
    images: { create: { url: "/synthetic.png" } } }, include: { inventory: true } });
  productIds.push(product.id);
  const context = await anotherCart(product.id, options);
  let coupon: Coupon | null = null;
  if (options.coupon) {
    coupon = await db.coupon.create({ data: { code: "C" + randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase(),
      type: "PERCENT", value: 10, maxUses: 1 } }); couponIds.push(coupon.id);
  }
  return { product, category, context, coupon, request: input(coupon?.code) };
}
async function anotherCart(productId: string, options: { quantity?: number; giftWrap?: boolean } = {}): Promise<TrustedPendingCheckout> {
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid" } });
  userIds.push(user.id);
  const cart = await db.cart.create({ data: { userId: user.id,
    items: { create: { productId, quantity: options.quantity ?? 1, giftWrap: options.giftWrap ?? false } } } });
  cartIds.push(cart.id);
  return { cartId: cart.id, owner: { kind: "USER", userId: user.id } };
}
async function prepare(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options), result = await pending(f.request, f.context);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("Expected prepared order: " + result.code);
  return { ...f, result };
}
async function state(orderId: string) {
  return db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true,
    items: { include: { inventoryReservation: true } }, couponReservation: true } });
}
async function stock(productId: string) { return (await db.inventory.findUniqueOrThrow({ where: { productId } })).quantity; }
// Inject failures through the real transaction client: an exception must roll back every real write.
function failingDatabase(model: string, operation: string, failAt = 1): PaymentDatabase {
  return { $transaction: ((fn: (tx: Prisma.TransactionClient) => unknown, options?: object) => db.$transaction(async tx => {
    let calls = 0;
    const wrapped = new Proxy(tx, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== model) return typeof value === "function" ? value.bind(target) : value;
      return new Proxy(value, { get(delegate, key) {
        if (key === operation) return async (...args: unknown[]) => {
          if (++calls === failAt) throw new Error("Synthetic rollback injection");
          return Reflect.get(delegate, key).apply(delegate, args);
        };
        const method = Reflect.get(delegate, key);
        return typeof method === "function" ? method.bind(delegate) : method;
      } });
    } });
    return fn(wrapped as unknown as Prisma.TransactionClient);
  }, options)) as PaymentDatabase["$transaction"] };
}
beforeEach(() => { time = new Date(baseTime); vi.restoreAllMocks(); });
afterAll(async () => {
  const filter = { items: { some: { productId: { in: productIds } } } };
  const orders = (await db.order.findMany({ where: filter, select: { id: true } })).map(o => o.id);
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await db.couponReservation.deleteMany({ where: { orderId: { in: orders } } });
  await db.order.updateMany({ where: { id: { in: orders } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orders } } });
  await db.cart.deleteMany({ where: { id: { in: cartIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  await db.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("Atomic Safepay pending checkout (disposable database, no provider I/O)", () => {
  it("creates server-priced pending snapshots, holds and one READY attempt", async () => {
    const f = await prepare({ coupon: true, quantity: 2, giftWrap: true });
    const order = await state(f.result.orderId);
    expect(order).toMatchObject({ status: "PENDING", paymentStatus: "PENDING", subtotal: 2000, discountTotal: 200,
      giftWrapCharge: 300, deliveryFee: 200, total: 2300, paymentFlowVersion: 1, nextPaymentAttempt: 2,
      paymentOwnerOrderId: order.id, activePaymentId: f.result.paymentId, acceptedPaymentId: null });
    expect(order.id).toMatch(/^c/); // Prisma's automatic cuid() remains usable.
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({ attemptState: "READY", amount: 2300, expectedAmountMinor: BigInt(230000),
      provider: "SAFEPAY", attemptNumber: 1, trackerToken: null, creationStartedAt: null });
    expect(order.items[0].inventoryReservation).toMatchObject({ state: "HELD", quantity: 2 });
    expect(order.couponReservation).toMatchObject({ state: "HELD" });
    expect(await stock(f.product.id)).toBe(3);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 1 });
    expect(await db.cartItem.count({ where: { cartId: f.context.cartId } })).toBe(0);
    // The previous phase's provider claim accepts the new real reservations.
    expect((await createPrismaSafepayStore(database).claim({ orderId: order.id, paymentId: order.payments[0].id,
      requestKey: randomUUID() }, bindCheckoutOwner(f.context.owner), config, time)).kind).toBe("claimed");
    expect(await stock(f.product.id)).toBe(3);
  });
  it("reuses a key after the cart is cleared, without reserving a second time", async () => {
    const f = await prepare({ coupon: true });
    expect(await pending(f.request, f.context)).toEqual({ ...f.result, reused: true });
    expect(await stock(f.product.id)).toBe(4);
    expect((await state(f.result.orderId)).payments).toHaveLength(1);
  });
  it("rejects changed input with an existing idempotency key", async () => {
    const f = await prepare();
    expect(await pending({ ...f.request, deliveryMethod: "EXPRESS" }, f.context)).toEqual({ kind: "blocked", code: "REQUEST_CONFLICT" });
  });
  it("uses changed database prices rather than stale cart display amounts", async () => {
    const f = await fixture();
    await db.product.update({ where: { id: f.product.id }, data: { price: 1600 } });
    const result = await pending(f.request, f.context);
    if (result.kind !== "ready") throw new Error("Expected order");
    expect(await state(result.orderId)).toMatchObject({ subtotal: 1600, total: 1800 });
  });
  it.each(["amount", "redirect_url", "checkoutOwnerHash", "items"])("rejects browser-supplied %s", async field => {
    const f = await fixture();
    expect(await pending({ ...f.request, [field]: 1 }, f.context)).toEqual({ kind: "blocked", code: "INVALID_REQUEST" });
    expect(await stock(f.product.id)).toBe(5);
  });
  it.each(["cart", "owner"])("rejects unowned checkout context: %s", async kind => {
    const f = await fixture(), other = await fixture();
    const context = { ...f.context, ...(kind === "cart" ? { cartId: other.context.cartId } : { owner: other.context.owner }) };
    expect(await pending(f.request, context)).toEqual({ kind: "blocked", code: "NOT_ELIGIBLE" });
    expect(await stock(f.product.id)).toBe(5);
  });
  it("rejects a guest owner before creating an order, payment attempt, or reservation", async () => {
    const f = await fixture({ coupon: true });
    const forgedGuestContext = {
      ...f.context,
      owner: { kind: "GUEST", guestToken: randomBytes(32).toString("base64url") },
    } as unknown as TrustedPendingCheckout;

    expect(await pending(f.request, forgedGuestContext)).toEqual({ kind: "blocked", code: "NOT_ELIGIBLE" });
    expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(0);
    expect(await db.payment.count({ where: { order: { items: { some: { productId: f.product.id } } } } })).toBe(0);
    expect(await db.inventoryReservation.count({ where: { inventoryId: f.product.inventory!.id } })).toBe(0);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 0 });
    expect(await stock(f.product.id)).toBe(5);
  });
  it.each(["zero-stock", "partial-stock", "archived", "deleted", "invalid-quantity"])("fails safely for %s", async kind => {
    const f = await fixture({ quantity: kind === "partial-stock" ? 6 : 1 });
    if (kind === "zero-stock") await db.inventory.update({ where: { productId: f.product.id }, data: { quantity: 0 } });
    if (kind === "archived") await db.product.update({ where: { id: f.product.id }, data: { status: "ARCHIVED" } });
    if (kind === "deleted") await db.product.update({ where: { id: f.product.id }, data: { deletedAt: time } });
    if (kind === "invalid-quantity") await db.cartItem.updateMany({ where: { cartId: f.context.cartId }, data: { quantity: 0 } });
    expect(await pending(f.request, f.context)).toEqual({ kind: "blocked", code: "OUT_OF_STOCK" });
    expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(0);
    expect(await db.cartItem.count({ where: { cartId: f.context.cartId } })).toBe(1);
  });
  it.each(["missing", "inactive", "exhausted", "reserved", "minimum", "future", "expired"])("rolls back an unavailable coupon: %s", async kind => {
    const f = await fixture({ coupon: true });
    if (kind === "inactive") await db.coupon.update({ where: { id: f.coupon!.id }, data: { isActive: false } });
    if (kind === "exhausted") await db.coupon.update({ where: { id: f.coupon!.id }, data: { usedCount: 1 } });
    if (kind === "reserved") await db.coupon.update({ where: { id: f.coupon!.id }, data: { reservedCount: 1 } });
    if (kind === "minimum") await db.coupon.update({ where: { id: f.coupon!.id }, data: { minOrderAmount: 5000 } });
    if (kind === "future") await db.coupon.update({ where: { id: f.coupon!.id }, data: { startsAt: new Date(time.getTime() + 1000) } });
    if (kind === "expired") await db.coupon.update({ where: { id: f.coupon!.id }, data: { expiresAt: new Date(time.getTime() - 1000) } });
    const request = kind === "missing" ? { ...f.request, couponCode: "MISSING" } : f.request;
    expect(await pending(request, f.context)).toEqual({ kind: "blocked", code: "COUPON_UNAVAILABLE" });
    expect(await stock(f.product.id)).toBe(5);
  });
  it.each([["payment", "create"], ["paymentEvidence", "create"], ["cartItem", "deleteMany"], ["order", "create"]])(
    "rolls back orders, stock, coupon capacity and cart on %s.%s failure", async (model, method) => {
      const f = await fixture({ coupon: true });
      expect(await makeService(failingDatabase(model, method))(f.request, f.context)).toEqual({ kind: "blocked", code: "PERSISTENCE_UNAVAILABLE" });
      expect(await stock(f.product.id)).toBe(5);
      expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 0 });
      expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(0);
      expect(await db.cartItem.count({ where: { cartId: f.context.cartId } })).toBe(1);
    });
  it("rolls back earlier stock deductions and coupon holds when the second inventory write fails", async () => {
    const f = await fixture({ coupon: true }), second = await fixture();
    await db.cartItem.create({ data: { cartId: f.context.cartId, productId: second.product.id, quantity: 1 } });
    expect(await makeService(failingDatabase("inventory", "updateMany", 2))(f.request, f.context))
      .toEqual({ kind: "blocked", code: "PERSISTENCE_UNAVAILABLE" });
    expect(await stock(f.product.id)).toBe(5); expect(await stock(second.product.id)).toBe(5);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 0, usedCount: 0 });
    expect(await db.cartItem.count({ where: { cartId: f.context.cartId } })).toBe(2);
    expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(0);
  });
  it("rolls back a transaction that outlives its local reservation deadline", async () => {
    const f = await fixture({ coupon: true }); let calls = 0;
    const run = createSafepayPendingOrderService({ database, getSettings: async () => settings,
      environment: "sandbox", merchantAccountRef: "synthetic-account", reservationTtlMs: 1000,
      now: () => new Date(baseTime.getTime() + (calls++ ? 1001 : 0)) });
    expect(await run(f.request, f.context)).toEqual({ kind: "blocked", code: "CHECKOUT_CLOSED" });
    expect(await stock(f.product.id)).toBe(5);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 0 });
    expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(0);
  });
  it("retries an aborted local serialization transaction without duplicating its writes", async () => {
    const f = await fixture({ coupon: true }); let calls = 0;
    const retryDatabase = { $transaction: ((...args: Parameters<PaymentDatabase["$transaction"]>) => {
      if (calls++ === 0) return Promise.reject({ code: "P2034" });
      return Reflect.apply(db.$transaction, db, args);
    }) as PaymentDatabase["$transaction"] };
    const result = await makeService(retryDatabase)(f.request, f.context);
    expect(result.kind).toBe("ready"); expect(calls).toBe(2);
    expect(await stock(f.product.id)).toBe(4);
    expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(1);
  });
  it("allows only one winner for the last inventory unit across concurrent carts", async () => {
    const f = await fixture({ stock: 1 }), other = await anotherCart(f.product.id);
    const results = await Promise.all([pending(f.request, f.context), pending(input(), other)]);
    expect(results.filter(r => r.kind === "ready")).toHaveLength(1);
    expect(results.filter(r => r.kind === "blocked")).toHaveLength(1);
    expect(await stock(f.product.id)).toBe(0);
    expect(await db.inventoryReservation.count({ where: { inventoryId: f.product.inventory!.id } })).toBe(1);
  });
  it("allows only one winner for the final coupon use across concurrent carts", async () => {
    const f = await fixture({ coupon: true }), other = await anotherCart(f.product.id);
    const results = await Promise.all([pending(f.request, f.context), pending(input(f.coupon!.code), other)]);
    expect(results.filter(r => r.kind === "ready")).toHaveLength(1);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 1 });
    expect(await stock(f.product.id)).toBe(4);
  });
  it.each([true, false])("does not duplicate a concurrent cart submission; same key=%s", async sameKey => {
    const f = await fixture();
    const results = await Promise.all([pending(f.request, f.context), pending(sameKey ? f.request : input(), f.context)]);
    expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(1);
    const ready = results.filter(r => r.kind === "ready");
    expect(ready.length).toBeGreaterThan(0);
    expect(new Set(ready.map(r => r.orderId)).size).toBe(1);
    expect(await stock(f.product.id)).toBe(4);
  });
  it.each(["stock", "coupon", "duplicate"])("serializes independent Prisma clients competing for %s", async target => {
    const { PrismaClient } = await import("../../generated/sqlite-client");
    const otherDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    try {
      const f = await fixture({ stock: target === "stock" ? 1 : 5, coupon: target === "coupon" });
      const otherContext = target === "duplicate" ? f.context : await anotherCart(f.product.id);
      const request = target === "duplicate" ? f.request : input(f.coupon?.code);
      const results = await Promise.all([pending(f.request, f.context), makeService(otherDb as unknown as PaymentDatabase)(request, otherContext)]);
      expect(results.some(r => r.kind === "ready")).toBe(true);
      expect(await db.order.count({ where: { items: { some: { productId: f.product.id } } } })).toBe(1);
      expect(await stock(f.product.id)).toBe(target === "stock" ? 0 : 4);
      if (f.coupon) expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon.id } })).toMatchObject({ reservedCount: 1 });
    } finally { await otherDb.$disconnect(); }
  });
});

describe("Reservation-aware close, expire, admin writers and fulfilment", () => {
  it("releases unstarted holds once through admin cancellation without marking a provider failure", async () => {
    const f = await prepare({ coupon: true });
    expect(await adminUpdateOrderStatus(f.result.orderId, "CANCELLED")).toMatchObject({ ok: true });
    const order = await state(f.result.orderId);
    expect(order).toMatchObject({ status: "CANCELLED", paymentStatus: "PENDING", checkoutCloseReason: "CANCELLED" });
    expect(order.items[0].inventoryReservation).toMatchObject({ state: "RELEASED" });
    expect(order.payments[0]).toMatchObject({ attemptState: "CLOSED", status: "PENDING" });
    expect(await stock(f.product.id)).toBe(5);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 0 });
    expect(await reservations.cancel(order.id, f.context.owner)).toEqual({ ok: true, outcome: "ALREADY_CLOSED" });
    expect(await stock(f.product.id)).toBe(5);
    expect(await pending(f.request, f.context)).toEqual({ kind: "blocked", code: "CHECKOUT_CLOSED" });
  });
  it("does not let another checkout owner release a hold", async () => {
    const f = await prepare();
    expect((await reservations.cancel(f.result.orderId, {
      kind: "GUEST", guestToken: randomBytes(32).toString("base64url"),
    } as never)).ok).toBe(false);
    expect(await stock(f.product.id)).toBe(4);
  });
  it("expires unstarted holds once and does not expire a live reservation", async () => {
    const f = await prepare({ coupon: true });
    expect((await reservations.expireBatch()).some(r => r.orderId === f.result.orderId)).toBe(false);
    time = new Date(baseTime.getTime() + 600_001);
    expect((await reservations.expireBatch()).find(r => r.orderId === f.result.orderId)?.result).toEqual({ ok: true, outcome: "RELEASED" });
    expect((await state(f.result.orderId)).checkoutCloseReason).toBe("EXPIRED");
    expect(await stock(f.product.id)).toBe(5);
    expect((await reservations.expireBatch()).some(r => r.orderId === f.result.orderId)).toBe(false);
  });
  it.each(["CREATING", "TRACKER_CREATED", "CREATION_UNCERTAIN", "CHECKOUT_ISSUED"])("retains holds for potentially payable %s", async attemptState => {
    const f = await prepare({ coupon: true });
    await db.payment.update({ where: { id: f.result.paymentId }, data: { attemptState, creationStartedAt: time } });
    time = new Date(baseTime.getTime() + 600_001);
    expect((await reservations.expireBatch()).find(r => r.orderId === f.result.orderId)?.result).toEqual({ ok: true, outcome: "REVIEW_REQUIRED" });
    const order = await state(f.result.orderId);
    expect(order).toMatchObject({ status: "CANCELLED", paymentStatus: "PENDING", paymentReviewStatus: "REQUIRED" });
    expect(order.items[0].inventoryReservation?.state).toBe("HELD");
    expect(order.payments[0]).toMatchObject({ status: "PENDING", reconcileStatus: "REVIEW_REQUIRED" });
    expect(await stock(f.product.id)).toBe(4);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 1, usedCount: 0 });
  });
  it("serializes concurrent cancellation and expiration without duplicate restoration", async () => {
    const f = await prepare({ coupon: true }); time = new Date(baseTime.getTime() + 600_001);
    await Promise.all([reservations.cancel(f.result.orderId, f.context.owner), reservations.expireBatch()]);
    expect(await stock(f.product.id)).toBe(5);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 0, usedCount: 0 });
    expect(await db.paymentEvidence.count({ where: { paymentId: f.result.paymentId, decision: "RESERVATIONS_RELEASED" } })).toBe(1);
  });
  it("serializes provider creation claim against cancellation without releasing a payable hold", async () => {
    const f = await prepare(), store = createPrismaSafepayStore(database);
    const [claim, closed] = await Promise.all([store.claim({ orderId: f.result.orderId, paymentId: f.result.paymentId,
      requestKey: randomUUID() }, bindCheckoutOwner(f.context.owner), config, time), reservations.cancel(f.result.orderId, f.context.owner)]);
    const order = await state(f.result.orderId);
    if (claim.kind === "claimed") {
      expect(await stock(f.product.id)).toBe(4);
      if (closed.ok) expect(order.paymentReviewStatus).toBe("REQUIRED");
    } else if (closed.ok) expect(await stock(f.product.id)).toBe(5);
    expect(order.paymentStatus).toBe("PENDING");
  });
  it.each([["paymentEvidence", "create"], ["inventoryReservation", "updateMany"], ["payment", "updateMany"]])(
    "rolls back the entire release if %s.%s fails", async (model, method) => {
      const f = await prepare({ coupon: true });
      expect((await createSafepayReservationService(failingDatabase(model, method), clock).cancel(f.result.orderId, f.context.owner)).ok).toBe(false);
      expect(await stock(f.product.id)).toBe(4);
      expect(await state(f.result.orderId)).toMatchObject({ status: "PENDING", checkoutClosedAt: null });
      expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 1 });
    });
  it("rolls back coupon release if an inventory reservation is missing", async () => {
    const f = await prepare({ coupon: true });
    await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: f.result.orderId } } });
    expect((await reservations.cancel(f.result.orderId, f.context.owner)).ok).toBe(false);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 1 });
    expect((await state(f.result.orderId)).status).toBe("PENDING");
    expect(await stock(f.product.id)).toBe(4);
  });
  it("rolls back earlier stock restoration and coupon release when the second restoration fails", async () => {
    const f = await fixture({ coupon: true }), second = await fixture();
    await db.cartItem.create({ data: { cartId: f.context.cartId, productId: second.product.id, quantity: 1 } });
    const result = await pending(f.request, f.context); if (result.kind !== "ready") throw new Error("Expected order");
    expect((await createSafepayReservationService(failingDatabase("inventory", "updateMany", 2), clock)
      .cancel(result.orderId, f.context.owner)).ok).toBe(false);
    expect(await stock(f.product.id)).toBe(4); expect(await stock(second.product.id)).toBe(4);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ reservedCount: 1 });
    expect((await state(result.orderId)).items.every(item => item.inventoryReservation?.state === "HELD")).toBe(true);
  });
  it.each(["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED"])("blocks unpaid managed fulfilment from %s", async status => {
    const f = await prepare(); await db.order.update({ where: { id: f.result.orderId }, data: { status } });
    const next = { PENDING: "CONFIRMED", CONFIRMED: "PROCESSING", PROCESSING: "SHIPPED", SHIPPED: "DELIVERED" }[status]!;
    expect((await adminUpdateOrderStatus(f.result.orderId, next as "CONFIRMED")).ok).toBe(false);
    expect(await stock(f.product.id)).toBe(4);
  });
  it("does not trust an order/payment PAID label without verified capture and consumed holds", async () => {
    const f = await prepare();
    await db.order.update({ where: { id: f.result.orderId }, data: { paymentStatus: "PAID", acceptedPaymentId: f.result.paymentId } });
    await db.payment.update({ where: { id: f.result.paymentId }, data: { status: "PAID" } });
    expect((await adminUpdateOrderStatus(f.result.orderId, "CONFIRMED")).ok).toBe(false);
    expect((await adminUpdateOrderStatus(f.result.orderId, "CANCELLED")).ok).toBe(false);
    expect(await stock(f.product.id)).toBe(4);
  });
  it("advances a synthetic verified and consumed order without another deduction", async () => {
    const f = await prepare({ coupon: true });
    // Synthetic fixture only: the production settlement handler is deliberately not implemented.
    await db.$transaction(async tx => {
      await tx.order.update({ where: { id: f.result.orderId }, data: { paymentStatus: "PAID", acceptedPaymentId: f.result.paymentId } });
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: f.result.paymentId } });
      await tx.payment.update({ where: { id: payment.id }, data: { status: "PAID", paidVerifiedAt: time,
        capturedAmountMinor: payment.expectedAmountMinor, reconcileStatus: "VERIFIED" } });
      await tx.inventoryReservation.updateMany({ where: { orderItem: { orderId: f.result.orderId } }, data: { state: "CONSUMED", consumedAt: time } });
      await tx.couponReservation.update({ where: { orderId: f.result.orderId }, data: { state: "COMMITTED", committedAt: time } });
      await tx.coupon.update({ where: { id: f.coupon!.id }, data: { reservedCount: 0, usedCount: 1 } });
    });
    for (const status of ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] as const)
      expect(await adminUpdateOrderStatus(f.result.orderId, status)).toEqual({ ok: true });
    expect(await stock(f.product.id)).toBe(4);
  });
  it("blocks absolute inventory and product stock overwrites while a hold is active", async () => {
    const f = await prepare();
    expect((await adminUpdateInventory({ productId: f.product.id, quantity: 100 })).ok).toBe(false);
    await expect(adminUpdateProduct(f.product.id, { name: "Changed product", categoryId: f.category.id, price: 500,
      status: "PUBLISHED", isFeatured: false, images: ["/changed.png"], stock: 100 })).rejects.toThrow("reservations");
    expect(await stock(f.product.id)).toBe(4);
    expect((await db.product.findUniqueOrThrow({ where: { id: f.product.id } })).price).toBe(1000);
    await reservations.cancel(f.result.orderId, f.context.owner);
    expect(await adminUpdateInventory({ productId: f.product.id, quantity: 7 })).toEqual({ ok: true });
    expect(await stock(f.product.id)).toBe(7);
  });
  it("prevents coupon edits and deletion while held, and preserves reservation history", async () => {
    const f = await prepare({ coupon: true });
    const edit = { code: f.coupon!.code, type: "PERCENT" as const, value: 20, minOrderAmount: 0, maxUses: 1, isActive: true };
    await expect(adminUpdateCoupon(f.coupon!.id, edit)).rejects.toThrow("reservations");
    await expect(adminDeleteCoupon(f.coupon!.id)).rejects.toThrow("history");
    await reservations.cancel(f.result.orderId, f.context.owner);
    await expect(adminDeleteCoupon(f.coupon!.id)).rejects.toThrow("history");
    expect((await adminUpdateCoupon(f.coupon!.id, { ...edit, isActive: false })).isActive).toBe(false);
  });
  it("does not let an offline coupon use steal held capacity", async () => {
    const f = await prepare({ coupon: true });
    expect(await validateCoupon(f.coupon!.code, 1000)).toHaveProperty("error");
    expect(await db.$transaction(tx => reserveCoupon(tx, f.coupon!.code, 1000))).toHaveProperty("error");
    expect(await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).toMatchObject({ usedCount: 0, reservedCount: 1 });
  });
  it.each(["COD", "BANK_TRANSFER"] as const)("keeps %s checkout, cancellation and stock behavior alongside a Safepay hold", async method => {
    const f = await prepare({ coupon: true });
    vi.spyOn(settingsService, "getSettings").mockResolvedValue({ ...settings, bank_transfer_enabled: true });
    vi.spyOn(cartService, "getCartDetails").mockResolvedValue({ id: "synthetic-mock-cart", subtotal: 1000, itemCount: 1, wrappedUnits: 0,
      items: [{ itemId: "synthetic", productId: f.product.id, name: f.product.name, slug: f.product.slug, price: 1000,
        comparePrice: null, image: null, quantity: 1, stock: 4, lowStock: true, outOfStock: false, lineTotal: 1000,
        giftWrap: false, priceChanged: false }] });
    vi.spyOn(cartService, "clearCart").mockResolvedValue(undefined);
    const placed = await placeOrder({ ...input(f.coupon!.code), paymentMethod: method }, f.context.owner.userId);
    if (!placed.ok) throw new Error("Offline order failed");
    const order = await state(placed.orderId);
    expect(order).toMatchObject({ status: "CONFIRMED", paymentFlowVersion: null, couponCode: null, total: 1200 });
    expect(await stock(f.product.id)).toBe(3);
    expect(await adminUpdateOrderStatus(order.id, "CANCELLED")).toEqual({ ok: true });
    expect(await stock(f.product.id)).toBe(4);
    expect((await state(f.result.orderId)).items[0].inventoryReservation?.state).toBe("HELD");
  });
});
