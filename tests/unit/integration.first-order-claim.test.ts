// Integration tests — first-order-only coupon claim (R-1, D11, migration 20261121000001).
// Run with: node scripts/run-isolated-sqlite-tests.mjs tests/unit/integration.first-order-claim.test.ts
//
// Covers, against the real Prisma layer on a disposable SQLite database:
// - COD placeOrder and the Safepay pending-order service both set
//   Order.firstOrderCoupon from Coupon.firstOrderOnly at order creation;
// - the claim partial unique index is the atomic guard: two concurrent
//   bare orders with DIFFERENT first-order-only coupons for one user
//   cannot both commit (one P2002, detected by isFirstOrderClaimViolation);
// - a cancelled claimed order frees the claim, so cancel-then-redeem with
//   a different first-order coupon works (same rule as the count check);
// - a second first-order coupon after a claimed first order is rejected
//   with the existing first-order error, never silently dropped and never
//   placed without the coupon.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const cartCookie = vi.hoisted(() => ({ guestKey: "" }));
const sessionUser = vi.hoisted(() => ({ id: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cartCookie.guestKey ? { value: cartCookie.guestKey } : undefined) }),
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () =>
    sessionUser.id ? { user: { id: sessionUser.id }, iat: Math.floor(Date.now() / 1000) } : null,
  ),
}));

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

import { db } from "@/lib/db";
import { placeOrder } from "@/services/checkout.service";
import { customerCancelOrder } from "@/services/orders.service";
import { createSafepayPendingOrderService, type TrustedPendingCheckout } from "@/services/safepay-pending-order.service";
import { type PaymentDatabase } from "@/services/safepay-attempt.store";
import { DEFAULT_SETTINGS } from "@/services/settings.service";
import * as settingsService from "@/services/settings.service";
import { isFirstOrderClaimViolation } from "@/lib/coupon-validation";
import type { PlaceOrderInput } from "@/lib/validation";

assertDisposableTestDatabase();

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const couponCode = (prefix: string) =>
  `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`.slice(0, 20);

const userIds: string[] = [];
const productIds: string[] = [];
const categoryIds: string[] = [];
const couponIds: string[] = [];
const cartIds: string[] = [];

async function makeUser() {
  const user = await db.user.create({ data: { email: `foc-test-${suffix()}@example.invalid` } });
  userIds.push(user.id);
  return user;
}

async function seedProduct(stock: number, price = 1000) {
  const s = suffix();
  const cat = await db.category.create({ data: { name: `FocCat-${s}`, slug: `foccat-${s}`, isActive: true } });
  categoryIds.push(cat.id);
  const product = await db.product.create({
    data: {
      name: `Foc Test Watch ${s}`,
      slug: `foc-watch-${s}`,
      description: "test",
      categoryId: cat.id,
      price,
      status: "PUBLISHED",
      inventory: { create: { quantity: stock } },
      images: { create: { url: "/images/placeholder.svg", sortOrder: 0 } },
    },
    include: { inventory: true },
  });
  productIds.push(product.id);
  return { cat, product };
}

async function seedUserCart(userId: string, lines: Array<{ productId: string; quantity: number }>) {
  await db.cartItem.deleteMany({ where: { cart: { userId } } });
  const cart = await db.cart.upsert({ where: { userId }, update: {}, create: { userId } });
  cartIds.push(cart.id);
  if (lines.length > 0) {
    await db.cartItem.createMany({
      data: lines.map((line) => ({ cartId: cart.id, productId: line.productId, quantity: line.quantity, giftWrap: false })),
    });
  }
  return cart;
}

function checkoutInput(idempotencyKey: string, coupon?: string): PlaceOrderInput {
  return {
    idempotencyKey,
    customer: { name: "Test Buyer", email: "test@buyer.pk", phone: "03001234567" },
    address: {
      fullName: "Test Buyer",
      phone: "03001234567",
      line1: "Test Street 1",
      line2: "",
      city: "Lahore",
      province: "Punjab",
      postalCode: "",
    },
    deliveryMethod: "STANDARD" as const,
    paymentMethod: "COD" as const,
    couponCode: coupon,
  };
}

async function makeCoupon(data: {
  type?: "PERCENT" | "FIXED";
  value?: number;
  firstOrderOnly?: boolean;
}) {
  const coupon = await db.coupon.create({
    data: {
      code: couponCode("FOC"),
      type: data.type ?? "PERCENT",
      value: data.value ?? 10,
      firstOrderOnly: data.firstOrderOnly ?? false,
    },
  });
  couponIds.push(coupon.id);
  return coupon;
}

function bareOrder(userId: string, coupon: string) {
  const id = `foc-o-${suffix()}`;
  return db.order.create({
    data: {
      id,
      reference: `KH261121${id.slice(-10).toUpperCase()}`,
      idempotencyKey: `foc-idem-${suffix()}`,
      userId,
      customerName: "Foc Buyer",
      customerEmail: "foc@example.invalid",
      customerPhone: "03001234567",
      shipFullName: "Foc Buyer",
      shipPhone: "03001234567",
      shipLine1: "Foc Street 1",
      shipCity: "Lahore",
      shipProvince: "Punjab",
      status: "CONFIRMED",
      paymentMethod: "COD",
      paymentStatus: "PENDING",
      subtotal: 1000,
      total: 1000,
      couponCode: coupon,
      firstOrderCoupon: true,
    },
  });
}

const safepaySettings = { ...DEFAULT_SETTINGS, delivery_fee_standard: 200, gift_wrap_charge: 150 };
const pending = createSafepayPendingOrderService({
  database: db as unknown as PaymentDatabase,
  getSettings: async () => safepaySettings,
  environment: "sandbox",
  merchantAccountRef: "synthetic-account",
  reservationTtlMs: 600_000,
});

async function safepayCart(productId: string): Promise<TrustedPendingCheckout> {
  const user = await makeUser();
  const cart = await db.cart.create({
    data: { userId: user.id, items: { create: { productId, quantity: 1, giftWrap: false } } },
  });
  cartIds.push(cart.id);
  return { cartId: cart.id, owner: { kind: "USER", userId: user.id } };
}

function safepayInput(coupon?: string): PlaceOrderInput {
  return {
    idempotencyKey: randomUUID(),
    paymentMethod: "ONLINE" as const,
    deliveryMethod: "STANDARD" as const,
    customer: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "03001234567" },
    address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" },
    ...(coupon ? { couponCode: coupon } : {}),
  };
}

async function deleteOrdersForUser(userId: string) {
  const orders = await db.order.findMany({ where: { userId }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  if (ids.length === 0) return;
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: ids } } } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: ids } } } });
  await db.couponReservation.deleteMany({ where: { orderId: { in: ids } } });
  await db.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
  await db.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  // The order row references its payments (active/accepted) — null those
  // before deleting the payments, or the FK blocks the delete.
  await db.order.updateMany({ where: { id: { in: ids } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await db.order.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(() => {
  sessionUser.id = "";
  vi.restoreAllMocks();
  cartCookie.guestKey = "";
  // Zero delivery/gift-wrap so totals are exactly subtotal − discount.
  vi.spyOn(settingsService, "getSettings").mockResolvedValue({
    ...settingsService.DEFAULT_SETTINGS,
    cod_enabled: true,
    online_payment_enabled: false,
    delivery_fee_standard: 0,
    delivery_fee_express: 0,
    free_delivery_threshold: 0,
    gift_wrap_enabled: false,
    gift_wrap_charge: 0,
  });
});

afterEach(async () => {
  // Orders are per-user rows: remove this test's rows so no later suite
  // ever sees a first-order claim it did not create.
  for (const userId of [...userIds]) await deleteOrdersForUser(userId);
  if (couponIds.length) await db.coupon.deleteMany({ where: { id: { in: couponIds } } });
  couponIds.length = 0;
});

afterAll(async () => {
  // Chunk 7-final: order placement/cancellation now enqueues emails.
  // Remove this file's rows so later suites' small outbox sweeps are not
  // starved by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: { in: ["buyer@example.invalid", "test@buyer.pk"] } } });
  await db.cart.deleteMany({ where: { id: { in: cartIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  await db.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("R-1 first-order claim — COD placeOrder", () => {
  it("sets firstOrderCoupon on a first-order-coupon order, and false otherwise", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(10);
    const firstOnly = await makeCoupon({ firstOrderOnly: true });
    const regular = await makeCoupon({ firstOrderOnly: false });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const first = await placeOrder(checkoutInput(`foc-a-${suffix()}`, firstOnly.code), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first order to place");
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).firstOrderCoupon).toBe(true);

    // A second user with a regular coupon claims nothing.
    const other = await makeUser();
    await seedUserCart(other.id, [{ productId: product.id, quantity: 1 }]);
    const second = await placeOrder(checkoutInput(`foc-b-${suffix()}`, regular.code), other.id);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected regular-coupon order to place");
    expect((await db.order.findUniqueOrThrow({ where: { id: second.orderId } })).firstOrderCoupon).toBe(false);

    // And a no-coupon order claims nothing either.
    const third = await makeUser();
    await seedUserCart(third.id, [{ productId: product.id, quantity: 1 }]);
    const plain = await placeOrder(checkoutInput(`foc-c-${suffix()}`), third.id);
    expect(plain.ok).toBe(true);
    if (!plain.ok) throw new Error("Expected plain order to place");
    expect((await db.order.findUniqueOrThrow({ where: { id: plain.orderId } })).firstOrderCoupon).toBe(false);
  });

  it("rejects a DIFFERENT first-order coupon after a claimed first order, with the first-order error", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(10);
    const couponA = await makeCoupon({ firstOrderOnly: true });
    const couponB = await makeCoupon({ firstOrderOnly: true });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const first = await placeOrder(checkoutInput(`foc-d-${suffix()}`, couponA.code), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first order to place");

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const attempted = await placeOrder(checkoutInput(`foc-e-${suffix()}`, couponB.code), user.id);
    expect(attempted).toMatchObject({
      ok: false,
      code: "COUPON_UNAVAILABLE",
      error: "This coupon is only valid for your first order.",
    });
    // Exactly one live order: the attempt was rejected, not placed without the coupon.
    expect(await db.order.count({ where: { userId: user.id, status: { not: "CANCELLED" } } })).toBe(1);
  });

  it("a cancelled claimed first order frees the claim for a different first-order coupon", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(10);
    const couponA = await makeCoupon({ firstOrderOnly: true });
    const couponB = await makeCoupon({ firstOrderOnly: true });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const first = await placeOrder(checkoutInput(`foc-f-${suffix()}`, couponA.code), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first order to place");

    await customerCancelOrder(first.orderId, user.id);
    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const retry = await placeOrder(checkoutInput(`foc-g-${suffix()}`, couponB.code), user.id);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("Expected post-cancel first-order coupon to place");
    expect((await db.order.findUniqueOrThrow({ where: { id: retry.orderId } })).firstOrderCoupon).toBe(true);
  });
});

describe("R-1 first-order claim — the index is the atomic guard", () => {
  it("two concurrent bare orders with different first-order coupons: one P2002, detected as a claim violation", async () => {
    const user = await makeUser();
    const couponA = await makeCoupon({ firstOrderOnly: true });
    const couponB = await makeCoupon({ firstOrderOnly: true });

    // Two bare order rows racing on the same userId. The count pre-check
    // cannot serialize this (both reads see zero) — the partial unique
    // index (migration 20261121000001) must decide it. SQLite serialises
    // writers, so this proves the index shape here; the Postgres file
    // proves the same race under real concurrency.
    const results = await Promise.allSettled([
      bareOrder(user.id, couponA.code),
      bareOrder(user.id, couponB.code),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const reason = (losers[0] as PromiseRejectedResult).reason;
    expect(reason).toMatchObject({ code: "P2002" });
    expect(isFirstOrderClaimViolation(reason)).toBe(true);
    expect(await db.order.count({ where: { userId: user.id, firstOrderCoupon: true, status: { not: "CANCELLED" } } })).toBe(1);

    // And a cancelled claim leaves the index, so a replacement commits.
    const winnerId = (winners[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    await db.order.update({ where: { id: winnerId }, data: { status: "CANCELLED" } });
    const replacement = await bareOrder(user.id, couponB.code);
    expect(replacement).toMatchObject({ couponCode: couponB.code, firstOrderCoupon: true });
  });
});

describe("R-1 first-order claim — Safepay pending-order service", () => {
  it("sets firstOrderCoupon on the pending order; a second first-order coupon for the same user is blocked", async () => {
    const { product } = await seedProduct(10);
    const couponA = await makeCoupon({ firstOrderOnly: true });
    const couponB = await makeCoupon({ firstOrderOnly: true });

    const contextA = await safepayCart(product.id);
    const first = await pending(safepayInput(couponA.code), contextA);
    expect(first).toMatchObject({ kind: "ready" });
    if (first.kind !== "ready") throw new Error("Expected pending order to be ready: " + first.code);
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).firstOrderCoupon).toBe(true);

    // Same user, fresh cart, different first-order coupon: the pre-check
    // (and, under race, the claim index) must block it — never a second
    // live first-order redemption.
    const cart = await db.cart.upsert({
      where: { userId: contextA.owner.userId },
      update: {},
      create: { userId: contextA.owner.userId },
    });
    await db.cartItem.create({ data: { cartId: cart.id, productId: product.id, quantity: 1, giftWrap: false } });
    const second = await pending(safepayInput(couponB.code), {
      cartId: cart.id,
      owner: { kind: "USER", userId: contextA.owner.userId },
    });
    expect(second).toEqual({ kind: "blocked", code: "COUPON_UNAVAILABLE" });
    expect(await db.order.count({ where: { userId: contextA.owner.userId, status: { not: "CANCELLED" } } })).toBe(1);
  });
});
