// Integration tests — promotions engine + coupon rules (Phase 3, Chunk 11 —
// D10/D11, M-19/M-20/M-21, M-4, promotion optimistic lock).
// Run with: npm run test:db
//
// Covers, against the real Prisma layer on a disposable SQLite database:
// - the automatic-promotions engine (date window, minimum order, best
//   discount wins, never stacked with a coupon, server-side only);
// - max one redemption per user per coupon, enforced at validation AND
//   reservation, with cancellation freeing the redemption;
// - WELCOME10-style first-order-only coupons (cancelled first orders do
//   not count as a first order);
// - per-coupon max-discount caps (percentage clamped, different caps per
//   coupon);
// - date-order validation + promotion optimistic locking.
//
// Promotions and coupons are GLOBAL rows, so every test deletes the ones it
// created in afterEach — a leaked active promotion would discount other
// suites' checkouts in the shared database.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const cartCookie = vi.hoisted(() => ({ guestKey: "" }));
// Session for quoteOrder's request-scoped cart read: the mock returns this
// file's checkout user, set per test. placeOrder takes userId directly.
const sessionUser = vi.hoisted(() => ({ id: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => cartCookie.guestKey ? { value: cartCookie.guestKey } : undefined }),
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () =>
    sessionUser.id ? { user: { id: sessionUser.id }, iat: Math.floor(Date.now() / 1000) } : null
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
import { placeOrder, quoteOrder } from "@/services/checkout.service";
import { customerCancelOrder } from "@/services/orders.service";
import {
  evaluateAutomaticPromotion,
  adminUpdateCoupon,
  adminUpdatePromotion,
} from "@/services/promotions.service";
import type { PlaceOrderInput } from "@/lib/validation";
import * as settingsService from "@/services/settings.service";

assertDisposableTestDatabase();

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const couponCode = (prefix: string) =>
  `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`.slice(0, 20);

const userIds: string[] = [];
const productIds: string[] = [];
const categoryIds: string[] = [];
const couponIds: string[] = [];
const promotionIds: string[] = [];

async function makeUser() {
  const user = await db.user.create({ data: { email: `promo-test-${suffix()}@example.invalid` } });
  userIds.push(user.id);
  return user;
}

async function seedProduct(stock: number, price = 1000) {
  const s = suffix();
  const cat = await db.category.create({ data: { name: `PromoCat-${s}`, slug: `promocat-${s}`, isActive: true } });
  categoryIds.push(cat.id);
  const product = await db.product.create({
    data: {
      name: `Promo Test Watch ${s}`,
      slug: `promo-watch-${s}`,
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

async function seedUserCart(
  userId: string,
  lines: Array<{ productId: string; quantity: number }>
) {
  await db.cartItem.deleteMany({ where: { cart: { userId } } });
  const cart = await db.cart.upsert({ where: { userId }, update: {}, create: { userId } });
  if (lines.length > 0) {
    await db.cartItem.createMany({
      data: lines.map((line) => ({ cartId: cart.id, productId: line.productId, quantity: line.quantity, giftWrap: false })),
    });
  }
  return cart;
}

async function clearUserCart(userId: string) {
  await db.cartItem.deleteMany({ where: { cart: { userId } } });
}

function checkoutInput(idempotencyKey: string, couponCode?: string): PlaceOrderInput {
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
    couponCode,
  };
}

async function makeCoupon(data: {
  type: "PERCENT" | "FIXED";
  value: number;
  minOrderAmount?: number;
  maxUses?: number | null;
  maxDiscountAmount?: number | null;
  firstOrderOnly?: boolean;
}) {
  const coupon = await db.coupon.create({
    data: {
      code: couponCode("P11"),
      type: data.type,
      value: data.value,
      minOrderAmount: data.minOrderAmount ?? 0,
      maxUses: data.maxUses ?? null,
      maxDiscountAmount: data.maxDiscountAmount ?? null,
      firstOrderOnly: data.firstOrderOnly ?? false,
      isActive: true,
    },
  });
  couponIds.push(coupon.id);
  return coupon;
}

async function makePromotion(data: {
  title?: string;
  type: "PERCENT" | "FIXED";
  value: number;
  minOrderAmount?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  isActive?: boolean;
  createdAt?: Date;
}) {
  const promotion = await db.promotion.create({
    data: {
      title: data.title ?? `Promo ${suffix()}`,
      type: data.type,
      value: data.value,
      minOrderAmount: data.minOrderAmount ?? null,
      startsAt: data.startsAt ?? null,
      endsAt: data.endsAt ?? null,
      isActive: data.isActive ?? true,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
  promotionIds.push(promotion.id);
  return promotion;
}

async function deleteOrdersForUser(userId: string) {
  const orders = await db.order.findMany({ where: { userId }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  if (ids.length === 0) return;
  await db.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
  await db.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await db.payment.deleteMany({ where: { orderId: { in: ids } } });
  await db.order.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  // No suite-wide fixtures: every test builds its own user/product/coupon
  // so per-user counts never leak across tests.
});

beforeEach(() => {
  vi.restoreAllMocks();
  cartCookie.guestKey = "";
  sessionUser.id = "";
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
  // Promotions and coupons are global rows: remove this test's rows so no
  // later suite ever sees a discount it did not create.
  for (const userId of [...userIds]) await deleteOrdersForUser(userId);
  if (promotionIds.length) await db.promotion.deleteMany({ where: { id: { in: promotionIds } } });
  if (couponIds.length) await db.coupon.deleteMany({ where: { id: { in: couponIds } } });
  promotionIds.length = 0;
  couponIds.length = 0;
});

afterAll(async () => {
  // Chunk 7-final: order placement now enqueues a confirmation email.
  // Remove this file's rows so later suites' small outbox sweeps are not
  // starved by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: "test@buyer.pk" } });
  for (const userId of userIds) {
    await deleteOrdersForUser(userId);
    await db.cart.deleteMany({ where: { userId } });
  }
  if (productIds.length) await db.product.deleteMany({ where: { id: { in: productIds } } });
  if (categoryIds.length) await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  if (couponIds.length) await db.coupon.deleteMany({ where: { id: { in: couponIds } } });
  if (promotionIds.length) await db.promotion.deleteMany({ where: { id: { in: promotionIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("M-19/D10 automatic promotions engine", () => {
  it("returns null when no promotion applies", async () => {
    expect(await evaluateAutomaticPromotion(db, 1000)).toBeNull();
  });

  it("applies an active in-window promotion that meets the minimum", async () => {
    const now = new Date();
    const promo = await makePromotion({
      type: "PERCENT",
      value: 20,
      minOrderAmount: 500,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 3_600_000),
    });
    const found = await evaluateAutomaticPromotion(db, 1000);
    expect(found?.promotion.id).toBe(promo.id);
    expect(found?.discountTotal).toBe(200);
    expect(found?.rule.title).toBe(promo.title);
  });

  it("ignores promotions outside their window, below the minimum, or inactive", async () => {
    const now = new Date();
    await makePromotion({ type: "PERCENT", value: 50, startsAt: new Date(now.getTime() + 3_600_000) }); // future
    await makePromotion({ type: "PERCENT", value: 50, endsAt: new Date(now.getTime() - 60_000) }); // past
    await makePromotion({ type: "PERCENT", value: 50, minOrderAmount: 5000 }); // below minimum
    await makePromotion({ type: "PERCENT", value: 50, isActive: false }); // inactive
    expect(await evaluateAutomaticPromotion(db, 1000)).toBeNull();
  });

  it("picks the largest discount, breaking ties to the earliest-created promotion", async () => {
    const older = await makePromotion({
      type: "FIXED", value: 100, createdAt: new Date(Date.now() - 3_600_000),
    });
    const newer = await makePromotion({
      type: "PERCENT", value: 20, createdAt: new Date(),
    });
    // Subtotal 1000: FIXED 100 vs PERCENT 20% = 200 → the percent wins.
    expect((await evaluateAutomaticPromotion(db, 1000))?.promotion.id).toBe(newer.id);
    // Subtotal 400: FIXED 100 vs PERCENT 20% = 80 → the fixed wins.
    expect((await evaluateAutomaticPromotion(db, 400))?.promotion.id).toBe(older.id);
    // Subtotal 500: both give exactly 100 → the earliest-created wins.
    expect((await evaluateAutomaticPromotion(db, 500))?.promotion.id).toBe(older.id);
  });

  it("never stacks with a coupon: quote applies the coupon only", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(5);
    await makePromotion({ type: "PERCENT", value: 20 });
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });
    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    sessionUser.id = user.id;

    const withCoupon = await quoteOrder({ deliveryMethod: "STANDARD", couponCode: coupon.code }, user.id);
    expect(withCoupon).toMatchObject({ discountTotal: 100, couponApplied: coupon.code });
    expect(withCoupon.promotionApplied).toBeUndefined();

    const withoutCoupon = await quoteOrder({ deliveryMethod: "STANDARD" }, user.id);
    expect(withoutCoupon).toMatchObject({ discountTotal: 200 });
    expect(withoutCoupon.promotionApplied).toBeDefined();
    expect(withoutCoupon.couponApplied).toBeUndefined();
  });

  it("records the promotion on the order, and the coupon path records no promotion", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(5);
    const promo = await makePromotion({ type: "PERCENT", value: 20 });
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const promoOrder = await placeOrder(checkoutInput(`promo-order-${suffix()}`), user.id);
    expect(promoOrder.ok).toBe(true);
    if (!promoOrder.ok) throw new Error("Expected promotion order to place");
    const promoRow = await db.order.findUniqueOrThrow({ where: { id: promoOrder.orderId } });
    expect(promoRow).toMatchObject({
      subtotal: 1000, discountTotal: 200, total: 800,
      couponCode: null, couponTitle: null,
      promotionId: promo.id, promotionTitle: promo.title,
    });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const couponOrder = await placeOrder(checkoutInput(`coupon-order-${suffix()}`, coupon.code), user.id);
    expect(couponOrder.ok).toBe(true);
    if (!couponOrder.ok) throw new Error("Expected coupon order to place");
    const couponRow = await db.order.findUniqueOrThrow({ where: { id: couponOrder.orderId } });
    expect(couponRow).toMatchObject({
      subtotal: 1000, discountTotal: 100, total: 900,
      couponCode: coupon.code, couponTitle: coupon.code,
      promotionId: null, promotionTitle: null,
    });
  });
});

describe("M-20/D11 one redemption per user per coupon", () => {
  it("rejects a second redeem by the same user, then allows it after cancellation", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(10);
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const first = await placeOrder(checkoutInput(`first-${suffix()}`, coupon.code), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first order to place");
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);

    // The second redeem is rejected at validation time — the quote tells
    // the customer why instead of failing at checkout.
    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    sessionUser.id = user.id;
    const quoted = await quoteOrder({ deliveryMethod: "STANDARD", couponCode: coupon.code }, user.id);
    expect(quoted.couponError).toBe("You have already used this coupon.");
    const second = await placeOrder(checkoutInput(`second-${suffix()}`, coupon.code), user.id);
    expect(second).toMatchObject({ ok: false, code: "COUPON_UNAVAILABLE" });

    // Cancelling the first order frees the redemption: a COMMITTED
    // reservation is never "released", but the per-user check counts only
    // non-cancelled orders, so the cancelled order does not consume it.
    const cancelled = await customerCancelOrder(first.orderId, user.id, "Changed my mind");
    expect(cancelled).toMatchObject({ ok: true, order: { status: "CANCELLED" } });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const third = await placeOrder(checkoutInput(`third-${suffix()}`, coupon.code), user.id);
    expect(third.ok).toBe(true);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
  });

  it("does not let one user block another: the limit is per user, not per coupon", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { product } = await seedProduct(10);
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });

    await seedUserCart(a.id, [{ productId: product.id, quantity: 1 }]);
    expect((await placeOrder(checkoutInput(`a-${suffix()}`, coupon.code), a.id)).ok).toBe(true);
    await seedUserCart(b.id, [{ productId: product.id, quantity: 1 }]);
    expect((await placeOrder(checkoutInput(`b-${suffix()}`, coupon.code), b.id)).ok).toBe(true);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(2);
  });
});

describe("D11 WELCOME10-style first-order-only coupons", () => {
  it("rejects a first-order-only coupon when the user already has an order", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(10);
    const coupon = await makeCoupon({ type: "PERCENT", value: 10, firstOrderOnly: true });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const plain = await placeOrder(checkoutInput(`plain-${suffix()}`), user.id);
    expect(plain.ok).toBe(true);

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    sessionUser.id = user.id;
    const quoted = await quoteOrder({ deliveryMethod: "STANDARD", couponCode: coupon.code }, user.id);
    expect(quoted.couponError).toBe("This coupon is only valid for your first order.");
    const attempted = await placeOrder(checkoutInput(`attempt-${suffix()}`, coupon.code), user.id);
    expect(attempted).toMatchObject({ ok: false, code: "COUPON_UNAVAILABLE" });
  });

  it("allows the first order, and a cancelled first order does not count", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(10);
    const coupon = await makeCoupon({ type: "PERCENT", value: 10, firstOrderOnly: true });

    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const first = await placeOrder(checkoutInput(`w1-${suffix()}`, coupon.code), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first order to place");

    // Cancel it, then the user is a first-order customer again.
    await customerCancelOrder(first.orderId, user.id);
    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const retry = await placeOrder(checkoutInput(`w2-${suffix()}`, coupon.code), user.id);
    expect(retry.ok).toBe(true);
  });
});

describe("M-21/D11 per-coupon max-discount cap", () => {
  it("clamps a percentage discount to the coupon's cap, with a different cap per coupon", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(20);
    const capped300 = await makeCoupon({ type: "PERCENT", value: 50, maxDiscountAmount: 300 });
    const capped1000 = await makeCoupon({ type: "PERCENT", value: 50, maxDiscountAmount: 1000 });

    // Subtotal 5000 (5 × 1000): uncapped would be 2500.
    await seedUserCart(user.id, [{ productId: product.id, quantity: 5 }]);
    const first = await placeOrder(checkoutInput(`cap1-${suffix()}`, capped300.code), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected capped order to place");
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).discountTotal).toBe(300);

    await seedUserCart(user.id, [{ productId: product.id, quantity: 5 }]);
    const second = await placeOrder(checkoutInput(`cap2-${suffix()}`, capped1000.code), user.id);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected second capped order to place");
    expect((await db.order.findUniqueOrThrow({ where: { id: second.orderId } })).discountTotal).toBe(1000);
  });
});

describe("M-4 date-order validation (service level)", () => {
  it("rejects a coupon edit whose start is on or after its expiry", async () => {
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });
    await expect(
      adminUpdateCoupon(coupon.id, {
        code: coupon.code, type: "PERCENT", value: 10, minOrderAmount: 0, firstOrderOnly: false,
        startsAt: "2026-06-02", expiresAt: "2026-06-01", isActive: true,
      })
    ).rejects.toThrow("Start date must be before");
    // The row is untouched by the rejected edit.
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).expiresAt).toBeNull();
  });

  it("rejects a promotion edit whose start is on or after its end", async () => {
    const promo = await makePromotion({ type: "PERCENT", value: 10 });
    await expect(
      adminUpdatePromotion(promo.id, {
        title: promo.title, type: "PERCENT", value: 10,
        startsAt: "2026-06-02", endsAt: "2026-06-01", isActive: true,
      })
    ).rejects.toThrow("Start date must be before");
  });
});

describe("promotion optimistic lock", () => {
  const promoInput = (version?: number) => ({
    title: "Locked Sale", type: "PERCENT" as const, value: 20,
    minOrderAmount: 0, isActive: true,
    ...(version === undefined ? {} : { version }),
  });

  it("bumps the version on a current edit and rejects a stale one with 409 semantics", async () => {
    const promo = await makePromotion({ type: "PERCENT", value: 10 });
    expect(promo.version).toBe(0);

    const updated = await adminUpdatePromotion(promo.id, { ...promoInput(0), value: 20 });
    expect(updated.version).toBe(1);

    await expect(adminUpdatePromotion(promo.id, { ...promoInput(0), value: 30 }))
      .rejects.toThrow("Promotion changed. Refresh before editing.");

    // The current version still works after the rejected stale edit.
    const again = await adminUpdatePromotion(promo.id, { ...promoInput(1), value: 25 });
    expect(again.version).toBe(2);
    expect(again.value).toBe(25);
  });

  it("accepts an edit with no version (falls back to the current row)", async () => {
    const promo = await makePromotion({ type: "PERCENT", value: 10 });
    const updated = await adminUpdatePromotion(promo.id, promoInput());
    expect(updated.version).toBe(1);
  });
});

describe("coupon concurrency: one winner per redemption", () => {
  // Bare order row (no items) for the direct index test below.
  async function createBareOrder(userId: string, couponCode: string) {
    const s = suffix();
    return db.order.create({
      data: {
        reference: `KHP11-${s}`,
        idempotencyKey: `promo-index-${s}`,
        userId,
        customerName: "Test Buyer",
        customerEmail: "test@buyer.pk",
        customerPhone: "03001234567",
        shipFullName: "Test Buyer",
        shipPhone: "03001234567",
        shipLine1: "Test Street 1",
        shipCity: "Lahore",
        shipProvince: "Punjab",
        status: "CONFIRMED",
        paymentMethod: "COD",
        paymentStatus: "PENDING",
        subtotal: 1000,
        total: 1000,
        couponCode,
      },
    });
  }

  it("the one-redemption index is the atomic guard: two concurrent orders for one user + coupon, one P2002", async () => {
    const user = await makeUser();
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });

    // Two bare order rows racing on the same (userId, couponCode). The
    // per-user count is only a pre-check — both reads see zero — so the
    // partial unique index (migration 20261120000006) must decide it.
    const results = await Promise.allSettled([
      createBareOrder(user.id, coupon.code),
      createBareOrder(user.id, coupon.code),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ code: "P2002" });
    expect(await db.order.count({ where: { userId: user.id, couponCode: coupon.code, status: { not: "CANCELLED" } } })).toBe(1);

    // And a cancelled order leaves the index, so a replacement commits.
    const winnerId = (winners[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    await db.order.update({ where: { id: winnerId }, data: { status: "CANCELLED" } });
    await expect(createBareOrder(user.id, coupon.code)).resolves.toMatchObject({ couponCode: coupon.code });
  });

  it("concurrent double-redeem by the same user at checkout: exactly one order wins", async () => {
    const user = await makeUser();
    const { product } = await seedProduct(5);
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });

    // One cart, two checkouts racing. The cart lock serialises them; the
    // loser finds the cart consumed. Either way exactly one order carries
    // the coupon and capacity moves exactly once.
    await seedUserCart(user.id, [{ productId: product.id, quantity: 1 }]);
    const [ra, rb] = await Promise.all([
      placeOrder(checkoutInput(`same-a-${suffix()}`, coupon.code), user.id),
      placeOrder(checkoutInput(`same-b-${suffix()}`, coupon.code), user.id),
    ]);
    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ code: "EMPTY_CART" });
    expect(await db.order.count({ where: { userId: user.id, couponCode: coupon.code, status: { not: "CANCELLED" } } })).toBe(1);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
  });

  it("concurrent last-use race across two users: only one wins when one use remains", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { product } = await seedProduct(10);
    const coupon = await makeCoupon({ type: "PERCENT", value: 10, maxUses: 1 });

    await seedUserCart(a.id, [{ productId: product.id, quantity: 1 }]);
    await seedUserCart(b.id, [{ productId: product.id, quantity: 1 }]);
    const [ra, rb] = await Promise.all([
      placeOrder(checkoutInput(`race-a-${suffix()}`, coupon.code), a.id),
      placeOrder(checkoutInput(`race-b-${suffix()}`, coupon.code), b.id),
    ]);
    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ code: "COUPON_UNAVAILABLE" });
    expect(await db.order.count({ where: { couponCode: coupon.code, status: { not: "CANCELLED" } } })).toBe(1);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
  });
});
