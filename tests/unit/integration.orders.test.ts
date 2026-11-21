// Integration tests — order placement, idempotency & stock consistency against a
// throwaway SQLite database (FR-18, FR-27, BR-05/08/11, NFR-07).
// Run with: npm run test:db
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const cartCookie = vi.hoisted(() => ({ guestKey: "" }));
// Session for the real-database cart paths (Phase 3, chunk 1: placeOrder
// reads the cart straight from the DB, and quoteOrder/addToCart go through
// getSessionUser): the mock returns this file's checkout user, set in
// beforeAll. The implementation reads sessionUser.id at call time so
// beforeEach's restoreAllMocks cannot clear it.
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
import type { PlaceOrderInput } from "@/lib/validation";
import { adminListOrders, adminUpdateOrderStatus, customerCancelOrder, getOrderByReference, getUserOrders } from "@/services/orders.service";
import {
  adminListProducts,
  getProductBySlug,
  getProductMetadataBySlug,
  listProducts,
} from "@/services/products.service";
import { adminListCustomerSummaries } from "@/services/users.service";
import { addToCart, getCartDetailsForCart, mergeGuestCart } from "@/services/cart.service";
import * as settingsService from "@/services/settings.service";

// These tests run only through the disposable SQLite test harness. They exercise
// the real Prisma layer and never use the application's configured database:
//   • unique idempotencyKey constraint (duplicate orders blocked)
//   • order + items + payment created atomically
//   • inventory decremented exactly once
assertDisposableTestDatabase();

const KEY = `test-idem-${Date.now()}`;
let checkoutUserId = "";

async function seedProduct(
  stock: number,
  overrides: Partial<{
    name: string;
    description: string;
    brand: string | null;
    tags: string | null;
    categoryId: string;
  }> = {}
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cat = overrides.categoryId
    ? await db.category.findUniqueOrThrow({ where: { id: overrides.categoryId } })
    : await db.category.create({
        data: { name: `TestCat-${suffix}`, slug: `testcat-${suffix}`, isActive: true },
      });
  const product = await db.product.create({
    data: {
      name: overrides.name ?? "Integration Test Watch",
      slug: `test-watch-${suffix}`,
      description: overrides.description ?? "test",
      brand: overrides.brand,
      tags: overrides.tags,
      categoryId: overrides.categoryId ?? cat.id,
      price: 1000,
      status: "PUBLISHED",
      inventory: { create: { quantity: stock } },
      images: { create: { url: "/images/placeholder.svg", sortOrder: 0 } },
    },
    include: { inventory: true },
  });
  return { cat, product };
}

// Seed the signed-in user's REAL cart (Phase 3, chunk 1: placeOrder reads the
// cart straight from the database, so tests seed real lines instead of
// mocking getCartDetails). Clears any lines a previous test left behind —
// failed checkouts leave their lines in place.
async function seedUserCart(
  userId: string,
  lines: Array<{ productId: string; variantId?: string | null; quantity: number; giftWrap?: boolean }>
) {
  await db.cartItem.deleteMany({ where: { cart: { userId } } });
  const cart = await db.cart.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  if (lines.length > 0) {
    await db.cartItem.createMany({
      data: lines.map((line) => ({
        cartId: cart.id,
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantity: line.quantity,
        giftWrap: line.giftWrap ?? false,
      })),
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

async function createOrderWithItems(
  products: Array<{ id: string; name: string; slug: string }>,
  quantities: number[],
  options: {
    userId?: string;
    status?: string;
    paymentMethod?: string;
    paymentStatus?: string;
    couponCode?: string;
  } = {}
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return db.order.create({
    data: {
      reference: `KHT${suffix}`,
      idempotencyKey: `cancel-test-${suffix}`,
      isGuest: !options.userId,
      ...(options.userId ? { userId: options.userId } : {}),
      customerName: "Test Buyer",
      customerEmail: "test@buyer.pk",
      customerPhone: "03001234567",
      shipFullName: "Test Buyer",
      shipPhone: "03001234567",
      shipLine1: "Test Street 1",
      shipCity: "Lahore",
      shipProvince: "Punjab",
      status: options.status ?? "CONFIRMED",
      paymentMethod: options.paymentMethod ?? "COD",
      paymentStatus: options.paymentStatus ?? "PENDING",
      subtotal: 1000,
      total: 1000,
      ...(options.couponCode ? { couponCode: options.couponCode } : {}),
      items: {
        create: products.map((product, index) => ({
          productId: product.id,
          productName: product.name,
          productSlug: product.slug,
          unitPrice: 500,
          quantity: quantities[index],
          lineTotal: 500 * quantities[index],
        })),
      },
    },
    include: { items: true },
  });
}

beforeAll(async () => {
  // ensure a clean slate for this key
  await db.order.deleteMany({ where: { idempotencyKey: KEY } });
  const user = await db.user.create({ data: { email: `checkout-test-${Date.now()}@example.invalid` } });
  checkoutUserId = user.id;
  sessionUser.id = user.id;
});

beforeEach(() => {
  vi.restoreAllMocks();
  cartCookie.guestKey = "";
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

afterAll(async () => {
  // Chunk 7-final: order placement/status/cancel now enqueue customer
  // emails in the outbox. Remove this file's rows so later suites' small
  // outbox sweeps are not starved by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: "test@buyer.pk" } });
  await db.$disconnect();
});

describe("order tracking requires authentication (PR-04, D-01)", () => {
  it("does not expose a guest order by reference, with or without a signed-in user", async () => {
    const { cat, product } = await seedProduct(4);
    const guestOrder = await createOrderWithItems(
      [{ id: product.id, name: product.name, slug: product.slug }],
      [1]
    );
    try {
      // A know-only reference must not grant access: no session, and no
      // signed-in user owns a guest order.
      expect(await getOrderByReference(guestOrder.reference)).toBeNull();
      expect(await getOrderByReference(guestOrder.reference, "some-other-user")).toBeNull();
    } finally {
      await db.orderItem.deleteMany({ where: { orderId: guestOrder.id } });
      await db.order.delete({ where: { id: guestOrder.id } });
      await db.product.delete({ where: { id: product.id } });
      await db.category.delete({ where: { id: cat.id } });
    }
  });

  it("shows a customer's own order only to that customer", async () => {
    const { product } = await seedProduct(4);
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const result = await placeOrder(
      { ...checkoutInput(`tracking-own-${Date.now()}`), paymentMethod: "COD" },
      checkoutUserId
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    expect(await getOrderByReference(result.reference, checkoutUserId)).toMatchObject({
      id: result.orderId,
    });
    expect(await getOrderByReference(result.reference, "another-customer")).toBeNull();
    expect(await getOrderByReference(result.reference)).toBeNull();
  });
});

describe("order placement integrity", () => {
  it("merges a guest cart into the signed-in customer's cart after sign-in", async () => {
    const { cat, product } = await seedProduct(4);
    const guestKey = `guest-cart-${Date.now()}`;
    const guestCart = await db.cart.create({
      data: { sessionKey: guestKey, items: { create: { productId: product.id, quantity: 2, giftWrap: true } } },
    });
    cartCookie.guestKey = guestKey;

    await mergeGuestCart(checkoutUserId);

    const userCart = await db.cart.findUniqueOrThrow({
      where: { userId: checkoutUserId },
      include: { items: true },
    });
    expect(userCart.items).toMatchObject([{ productId: product.id, quantity: 2, giftWrap: true }]);
    expect(await db.cart.findUnique({ where: { id: guestCart.id } })).toBeNull();
    expect(cartCookie.guestKey).toBe(guestKey);
    await db.cart.delete({ where: { id: userCart.id } });
    await db.product.delete({ where: { id: product.id } });
    await db.category.delete({ where: { id: cat.id } });
  });

  it("does not create an order when no authenticated customer is supplied", async () => {
    const key = `unauthenticated-checkout-${Date.now()}`;
    const result = await placeOrder(checkoutInput(key), "");

    expect(result).toMatchObject({ ok: false, code: "AUTHENTICATION_REQUIRED" });
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
    expect(settingsService.getSettings).not.toHaveBeenCalled();
  });

  it("preserves COD checkout with automatic order IDs", async () => {
    const paymentMethod = "COD" as const;
    const { product } = await seedProduct(4);
    vi.mocked(settingsService.getSettings).mockResolvedValue({
      ...settingsService.DEFAULT_SETTINGS,
      cod_enabled: true,
      online_payment_enabled: false,
      delivery_fee_standard: 0,
      free_delivery_threshold: 0,
      gift_wrap_enabled: false,
    });
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);

    const result = await placeOrder({
      ...checkoutInput("relation-checkout-" + paymentMethod + "-" + Date.now()),
      paymentMethod,
    }, checkoutUserId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { items: true, payments: true },
    });
    expect(order.id).toMatch(/^c[a-z0-9]+$/);
    expect(order).toMatchObject({
      paymentMethod,
      status: "CONFIRMED",
      paymentStatus: "PENDING",
      subtotal: 1000,
      total: 1000,
      paymentFlowVersion: null,
      paymentOwnerOrderId: null,
    });
    expect(order.items).toHaveLength(1);
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({ provider: paymentMethod, amount: 1000, status: "PENDING" });
    // The checkout fingerprint is stored with the order (M-10).
    expect(order.checkoutFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(3);
  });

  it("rejects a bank-transfer checkout at the service layer (PR-04, D-02)", async () => {
    const { product } = await seedProduct(4);
    const key = `bank-transfer-rejected-${Date.now()}`;

    const result = await placeOrder(
      {
        ...checkoutInput(key),
        paymentMethod: "BANK_TRANSFER" as never,
      },
      checkoutUserId
    );

    expect(result).toMatchObject({ ok: false, code: "PAYMENT_DISABLED" });
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
  });

  it("creates order + items + payment and decrements stock once", async () => {
    const { cat, product } = await seedProduct(10);

    const order = await db.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          reference: `KHT${Date.now()}`,
          idempotencyKey: KEY,
          isGuest: true,
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
          subtotal: 2000,
          deliveryFee: 200,
          deliveryMethod: "STANDARD",
          total: 2200,
          items: {
            create: [
              {
                productId: product.id,
                productName: product.name,
                productSlug: product.slug,
                unitPrice: 1000,
                quantity: 2,
                lineTotal: 2000,
              },
            ],
          },
          payments: { create: { provider: "COD", amount: 2200, status: "PENDING" } },
        },
        include: { items: true, payments: true },
      });
      const res = await tx.inventory.updateMany({
        where: { productId: product.id, quantity: { gte: 2 } },
        data: { quantity: { decrement: 2 } },
      });
      expect(res.count).toBe(1);
      return created;
    });

    expect(order.items).toHaveLength(1);
    expect(order.payments).toHaveLength(1);

    const inv = await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } });
    expect(inv.quantity).toBe(8); // 10 − 2

    // duplicate submission with same key is impossible (unique constraint)
    await expect(
      db.order.create({
        data: {
          reference: `KHT${Date.now() + 1}`,
          idempotencyKey: KEY, // SAME key → must fail
          isGuest: true,
          customerName: "Dup",
          customerEmail: "d@x.pk",
          customerPhone: "03001234567",
          shipFullName: "Dup",
          shipPhone: "03001234567",
          shipLine1: "x",
          shipCity: "y",
          shipProvince: "z",
          subtotal: 1,
          total: 1,
        },
      })
    ).rejects.toThrow(); // P2002 unique constraint

    // cleanup
    await db.order.delete({ where: { id: order.id } });
    await db.product.delete({ where: { id: product.id } });
    await db.category.delete({ where: { id: cat.id } });
  });

  it("conditional stock guard blocks oversell (stock cannot go negative, BR-05)", async () => {
    const { product, cat } = await seedProduct(1);
    // try to decrement 5 when only 1 exists
    const res = await db.inventory.updateMany({
      where: { productId: product.id, quantity: { gte: 5 } },
      data: { quantity: { decrement: 5 } },
    });
    expect(res.count).toBe(0); // guard refused
    const inv = await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } });
    expect(inv.quantity).toBe(1); // unchanged
    await db.product.delete({ where: { id: product.id } });
    await db.category.delete({ where: { id: cat.id } });
  });

  it("restores cancellation stock once, including concurrent and repeated requests", async () => {
    const { product } = await seedProduct(3);
    const order = await createOrderWithItems([product], [2]);

    const results = await Promise.allSettled([
      adminUpdateOrderStatus(order.id, "CANCELLED"),
      adminUpdateOrderStatus(order.id, "CANCELLED"),
    ]);
    expect(results.filter((result) =>
      result.status === "fulfilled" && result.value.ok
    )).toHaveLength(1);

    const inventory = await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } });
    expect(inventory.quantity).toBe(5);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
    expect((await adminUpdateOrderStatus(order.id, "CANCELLED")).ok).toBe(false);
    expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(5);
  });

  it("rolls back cancellation status and earlier stock restores if a linked product has no inventory", async () => {
    const first = await seedProduct(3);
    const second = await seedProduct(3);
    const order = await createOrderWithItems([first.product, second.product], [2, 1]);
    await db.inventory.deleteMany({ where: { productId: second.product.id, variantId: null } });

    await expect(adminUpdateOrderStatus(order.id, "CANCELLED")).rejects.toThrow(
      "Unable to restore inventory"
    );

    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CONFIRMED");
    expect((await db.inventory.findFirstOrThrow({ where: { productId: first.product.id, variantId: null } })).quantity).toBe(3);
    expect(await db.inventory.findFirst({ where: { productId: second.product.id, variantId: null } })).toBeNull();
  });

  it("cancels from the saved item snapshot when its product was deleted", async () => {
    const { product } = await seedProduct(1);
    const order = await createOrderWithItems([product], [1]);
    await db.product.delete({ where: { id: product.id } });

    expect((await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).productId).toBeNull();
    expect((await adminUpdateOrderStatus(order.id, "CANCELLED")).ok).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
  });

  it("reserves a maxUses=1 coupon for at most one concurrent checkout", async () => {
    const { product } = await seedProduct(4);
    const couponCode = `RACE${Date.now()}`;
    const coupon = await db.coupon.create({
      data: { code: couponCode, type: "PERCENT", value: 10, maxUses: 1 },
    });
    // Two customers, two carts: the coupon CAS — not the cart lock — decides
    // the winner. Phase 3, H-5: the loser is REJECTED (COUPON_UNAVAILABLE),
    // not silently charged full price as the old code did.
    const secondUser = await db.user.create({ data: { email: `coupon-race-${Date.now()}@example.invalid` } });
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    await seedUserCart(secondUser.id, [{ productId: product.id, quantity: 1 }]);
    const keys = [`coupon-race-a-${Date.now()}`, `coupon-race-b-${Date.now()}`];

    const results = await Promise.all([
      placeOrder(checkoutInput(keys[0], couponCode), checkoutUserId),
      placeOrder(checkoutInput(keys[1], couponCode), secondUser.id),
    ]);
    const orders = await db.order.findMany({ where: { idempotencyKey: { in: keys } } });
    const currentCoupon = await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } });

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ code: "COUPON_UNAVAILABLE" });
    expect(currentCoupon.usedCount).toBe(1);
    expect(orders).toHaveLength(1);
    expect(orders.filter((order) => order.couponCode === couponCode)).toHaveLength(1);
    expect(orders.filter((order) => order.discountTotal > 0)).toHaveLength(1);
    for (const order of orders) {
      expect(order.discountTotal).toBe(order.couponCode ? 100 : 0);
    }
    // cleanup: the loser's cart still holds its line
    await clearUserCart(checkoutUserId);
    await clearUserCart(secondUser.id);
    await db.user.delete({ where: { id: secondUser.id } });
  });

  it("rolls coupon usage and order creation back when stock reservation fails", async () => {
    const { product } = await seedProduct(0);
    const couponCode = `ROLLBACK${Date.now()}`;
    const coupon = await db.coupon.create({
      data: { code: couponCode, type: "FIXED", value: 100, maxUses: 1 },
    });
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const key = `coupon-rollback-${Date.now()}`;

    const result = await placeOrder(checkoutInput(key, couponCode), checkoutUserId);

    expect(result).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    if (result.ok) throw new Error("Expected the mixed cart to be rejected");
    expect(result.error).toContain(product.name);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
    await clearUserCart(checkoutUserId);
  });

  it("stores coupon snapshot and matching discount on successful checkout", async () => {
    const { product } = await seedProduct(3);
    const couponCode = `SAVE${Date.now()}`;
    const coupon = await db.coupon.create({
      data: { code: couponCode, type: "PERCENT", value: 10, maxUses: 2 },
    });
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const key = `coupon-success-${Date.now()}`;

    const result = await placeOrder(checkoutInput(key, couponCode), checkoutUserId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order).toMatchObject({
      subtotal: 1000,
      discountTotal: 100,
      total: 900,
      couponCode,
      couponTitle: couponCode,
    });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
  });

  it("searches storefront name, description, brand, and tags without case sensitivity changes", async () => {
    const fixtures = [
      { overrides: { name: "nameCaseToken" }, query: "NAMECASETOKEN" },
      { overrides: { description: "descriptionCaseToken" }, query: "DESCRIPTIONCASETOKEN" },
      { overrides: { brand: "brandCaseToken" }, query: "BRANDCASETOKEN" },
      { overrides: { tags: "tagCaseToken" }, query: "TAGCASETOKEN" },
    ];

    for (const fixture of fixtures) {
      const { product } = await seedProduct(1, fixture.overrides);
      const result = await listProducts({ q: fixture.query });
      expect(result.items.some((item) => item.id === product.id)).toBe(true);
    }
  });

  it("filters a category and all of its descendants in the product query", async () => {
    const root = await db.category.create({
      data: { name: "Root", slug: `root-${Date.now()}`, isActive: true },
    });
    const child = await db.category.create({
      data: { name: "Child", slug: `child-${Date.now()}`, parentId: root.id, isActive: true },
    });
    const inactiveChild = await db.category.create({
      data: { name: "Inactive", slug: `inactive-${Date.now()}`, parentId: root.id, isActive: false },
    });
    const grandchild = await db.category.create({
      data: { name: "Grandchild", slug: `grandchild-${Date.now()}`, parentId: child.id, isActive: true },
    });
    const rootProduct = await seedProduct(1, { categoryId: root.id });
    const childProduct = await seedProduct(1, { categoryId: child.id });
    await seedProduct(1, { categoryId: inactiveChild.id });
    const grandchildProduct = await seedProduct(1, { categoryId: grandchild.id });

    // Filtering by the root now reaches grandchildren too (Phase 3: the
    // subtree is recursive, not one level deep); inactive branches stay out.
    const rootResults = await listProducts({ category: root.slug });
    expect(rootResults.items.map(({ id }) => id).sort()).toEqual(
      [rootProduct.product.id, childProduct.product.id, grandchildProduct.product.id].sort()
    );
    expect(rootResults.total).toBe(3);

    const childResults = await listProducts({ category: child.slug });
    expect(childResults.items.map(({ id }) => id).sort()).toEqual(
      [childProduct.product.id, grandchildProduct.product.id].sort()
    );
    expect(childResults.total).toBe(2);
  });

  it("derives product metadata from the canonical product detail shape", async () => {
    const { product } = await seedProduct(1, {
      name: "Metadata Watch",
      description: "A test description",
    });

    await db.productImage.create({
      data: { productId: product.id, url: "/first-metadata.png", sortOrder: -1 },
    });

    expect(await getProductMetadataBySlug(product.slug)).toEqual({
      name: product.name,
      description: product.description,
      images: [{ url: "/first-metadata.png" }],
    });
    expect(await getProductBySlug(product.slug)).toMatchObject({
      id: product.id,
      images: [
        { url: "/first-metadata.png" },
        { url: "/images/placeholder.svg" },
      ],
    });
  });

  it("searches admin product names using mixed-case terms", async () => {
    const { product } = await seedProduct(1, { name: "adminCaseTokenProduct" });

    const result = await adminListProducts({ q: "ADMINCASETOKEN" });

    expect(result.items.some((item) => item.id === product.id)).toBe(true);
  });

  it("aggregates admin customer totals without loading order histories", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await db.user.create({
      data: {
        email: `admin-summary-${suffix}@example.test`,
        name: "Admin Summary Test",
        role: "CUSTOMER",
      },
    });
    try {
      const createOrder = (status: string, total: number, index: number) =>
        db.order.create({
          data: {
            reference: `KHA${suffix}${index}`,
            idempotencyKey: `admin-summary-${suffix}-${index}`,
            userId: user.id,
            isGuest: false,
            customerName: user.name!,
            customerEmail: user.email,
            customerPhone: "03001234567",
            shipFullName: user.name!,
            shipPhone: "03001234567",
            shipLine1: "Test Street",
            shipCity: "Lahore",
            shipProvince: "Punjab",
            status,
            subtotal: total,
            total,
          },
        });

      await createOrder("CONFIRMED", 1_250, 1);
      await createOrder("CANCELLED", 500, 2);

      const customer = (await adminListCustomerSummaries({ perPage: 1000 })).items.find(
        (row) => row.id === user.id
      );
      expect(customer).toMatchObject({
        orderCount: 1,
        totalSpent: 1_250,
        addressCount: 0,
      });
    } finally {
      await db.order.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it("password hashing roundtrip (auth credentials never stored in plain text)", async () => {
    const hash = await bcrypt.hash("Test@1234", 12);
    expect(await bcrypt.compare("Test@1234", hash)).toBe(true);
    expect(await bcrypt.compare("WrongPass1", hash)).toBe(false);
    expect(hash).not.toContain("Test@1234");
  });
});

// ─── Checkout money-trust (Phase 3, chunk 1) ──────────────────────────────
describe("checkout money-trust (Phase 3, chunk 1)", () => {
  it("rejects an expired, exhausted or below-minimum coupon instead of charging full price (H-5)", async () => {
    const { product } = await seedProduct(4);
    const now = Date.now();
    const coupons = await Promise.all([
      db.coupon.create({ data: { code: `EXP${now}`, type: "PERCENT", value: 10, maxUses: 1, expiresAt: new Date(now - 1000) } }),
      db.coupon.create({ data: { code: `EXH${now}`, type: "PERCENT", value: 10, maxUses: 1, usedCount: 1 } }),
      db.coupon.create({ data: { code: `MIN${now}`, type: "PERCENT", value: 10, maxUses: 5, minOrderAmount: 5000 } }),
    ]);
    for (const coupon of coupons) {
      await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
      const key = `coupon-unavailable-${coupon.code}`;
      const result = await placeOrder(checkoutInput(key, coupon.code), checkoutUserId);
      expect(result).toMatchObject({ ok: false, code: "COUPON_UNAVAILABLE" });
      expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
      expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(coupon.usedCount);
      await clearUserCart(checkoutUserId);
    }
  });

  it("reports an unknown coupon code at quote instead of staying silent (M-34)", async () => {
    const { product } = await seedProduct(4);
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const quote = await quoteOrder({ deliveryMethod: "STANDARD", couponCode: "NOPE-123" });
    expect(quote.couponError).toBe("This coupon code is not valid.");
    expect(quote.couponApplied).toBeUndefined();
    await clearUserCart(checkoutUserId);
  });

  it("rejects a mixed cart and names the out-of-stock product (H-19)", async () => {
    const inStock = await seedProduct(4);
    const outOfStock = await seedProduct(0, { name: "Out Of Stock Widget" });
    await seedUserCart(checkoutUserId, [
      { productId: inStock.product.id, quantity: 1 },
      { productId: outOfStock.product.id, quantity: 1 },
    ]);
    const key = `mixed-cart-${Date.now()}`;
    const result = await placeOrder(checkoutInput(key), checkoutUserId);
    expect(result).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    if (result.ok) throw new Error("Expected the mixed cart to be rejected");
    expect(result.error).toContain("Out Of Stock Widget");
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
    // The in-stock line is NOT partially fulfilled either.
    expect((await db.inventory.findFirstOrThrow({ where: { productId: inStock.product.id, variantId: null } })).quantity).toBe(4);
    await clearUserCart(checkoutUserId);
  });

  it("decrements mixed-quantity and variant lines exactly once (batched stock update)", async () => {
    // Exercises the batched stock decrement + batched cart consumption:
    // lines with different quantities fall into different updateMany
    // groups, and the variant line decrements its own inventory row.
    // A double-decrement or a missed line would show up as wrong stock
    // or leftover cart lines below.
    const a = await seedProduct(10);
    const b = await seedProduct(5);
    const c = await seedProduct(0);
    const variant = await db.productVariant.create({
      data: {
        productId: c.product.id,
        label: "Size: M",
        sku: `VAR-M-${Date.now()}`,
        priceOverride: 1500,
        isActive: true,
        // The variant inventory row also belongs to the product, so the
        // nested create must connect it explicitly.
        inventory: { create: { quantity: 4, product: { connect: { id: c.product.id } } } },
      },
    });
    await seedUserCart(checkoutUserId, [
      { productId: a.product.id, quantity: 3 },
      { productId: b.product.id, quantity: 1 },
      { productId: c.product.id, variantId: variant.id, quantity: 2 },
    ]);
    const key = `batched-stock-${Date.now()}`;
    const result = await placeOrder(checkoutInput(key), checkoutUserId);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    expect((await db.inventory.findFirstOrThrow({ where: { productId: a.product.id, variantId: null } })).quantity).toBe(7);
    expect((await db.inventory.findFirstOrThrow({ where: { productId: b.product.id, variantId: null } })).quantity).toBe(4);
    expect((await db.inventory.findFirstOrThrow({ where: { productId: c.product.id, variantId: variant.id } })).quantity).toBe(2);
    // The variant line's order item still carries its label, SKU and
    // image: the image comes from the in-transaction re-read, which is
    // the only cart read that still fetches images.
    const items = await db.orderItem.findMany({ where: { orderId: result.orderId } });
    expect(items).toHaveLength(3);
    const variantItem = items.find((item) => item.variantId === variant.id);
    expect(variantItem).toMatchObject({ variantLabel: "Size: M", unitPrice: 1500, quantity: 2 });
    expect(variantItem?.imageUrl).toBe("/images/placeholder.svg");
    // The batched cart consumption removed every line, none twice.
    expect(await db.cartItem.count({ where: { cart: { userId: checkoutUserId } } })).toBe(0);
  });

  it("places exactly one order for concurrent different-key checkouts of one cart (H-4)", async () => {
    for (const stock of [1, 2]) {
      const { product } = await seedProduct(stock);
      await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
      const keys = [`cart-race-a-${stock}-${Date.now()}`, `cart-race-b-${stock}-${Date.now()}`];
      const results = await Promise.all(keys.map((key) => placeOrder(checkoutInput(key), checkoutUserId)));
      const orders = await db.order.findMany({ where: { idempotencyKey: { in: keys } } });
      // The stock-2 case proves the cart lock — not stock — prevents the
      // double-order: both checkouts could have been fulfilled from stock.
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(orders).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({ code: "EMPTY_CART" });
      expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(stock - 1);
    }
  });

  it("binds the idempotency key to the checkout fingerprint (M-10)", async () => {
    const { product } = await seedProduct(4);
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const key = `fingerprint-${Date.now()}`;
    const first = await placeOrder(checkoutInput(key), checkoutUserId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const order = await db.order.findUniqueOrThrow({ where: { id: first.orderId } });
    expect(order.checkoutFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Same key, same payload: the same order comes back, no duplicate.
    const replay = await placeOrder(checkoutInput(key), checkoutUserId);
    expect(replay).toMatchObject({ ok: true, orderId: first.orderId, reference: first.reference });
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1);

    // Same key, different address: a conflict, not the old order.
    const moved = await placeOrder(
      { ...checkoutInput(key), address: { ...checkoutInput(key).address, line1: "Different Street 99" } },
      checkoutUserId
    );
    expect(moved).toMatchObject({ ok: false, code: "DUPLICATE" });
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1);

    // Same key, different coupon: also a conflict, and the coupon is not consumed.
    const coupon = await db.coupon.create({ data: { code: `FP${Date.now()}`, type: "PERCENT", value: 10, maxUses: 5 } });
    const discounted = await placeOrder(checkoutInput(key, coupon.code), checkoutUserId);
    expect(discounted).toMatchObject({ ok: false, code: "DUPLICATE" });
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
  });

  it("keeps cart and quote subtotals equal when stock drops after adding (H-9)", async () => {
    const { product } = await seedProduct(5);
    const cart = await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 3 }]);
    const before = await getCartDetailsForCart(cart.id);
    expect(before).toMatchObject({ subtotal: 3000, itemCount: 3 });
    // Stock drops below the stored quantity after the items were added.
    await db.inventory.updateMany({ where: { productId: product.id, variantId: null }, data: { quantity: 1 } });
    const after = await getCartDetailsForCart(cart.id);
    expect(after).toMatchObject({ subtotal: 1000, itemCount: 1 });
    expect(after!.items[0]).toMatchObject({ quantity: 1 });
    const quote = await quoteOrder({ deliveryMethod: "STANDARD" });
    expect(quote.subtotal).toBe(after!.subtotal);
    expect(quote.itemCount).toBe(after!.itemCount);
    await clearUserCart(checkoutUserId);
  });

  it("throws when adding more than the available stock (H-8)", async () => {
    const { product } = await seedProduct(2);
    await expect(addToCart(product.id, 3)).rejects.toThrow("Only 2 unit(s) available in stock");
    expect(await db.cartItem.count({ where: { cart: { userId: checkoutUserId } } })).toBe(0);
    expect((await addToCart(product.id, 2)).itemCount).toBe(2);
    await expect(addToCart(product.id, 1)).rejects.toThrow("Only 2 unit(s) available in stock");
    expect((await db.cartItem.findFirstOrThrow({ where: { cart: { userId: checkoutUserId } } })).quantity).toBe(2);
    await clearUserCart(checkoutUserId);
  });
});

// ─── Admin order search & filters (FR-41, admin orders fix) ─────────────────
describe("adminListOrders — search and filter integrity", () => {
  async function seedSearchOrder(overrides: {
    reference?: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
    status?: string;
    paymentStatus?: string;
  }) {
    const user = await db.user.create({
      data: {
        email: overrides.customerEmail ?? `search-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: overrides.customerName ?? "Search Probe",
        passwordHash: await bcrypt.hash("Search@1234", 4),
        role: "CUSTOMER",
        emailVerified: new Date(),
      },
    });
    const ref = overrides.reference ?? `KH-SEARCH-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const order = await db.order.create({
      data: {
        reference: ref,
        userId: user.id,
        customerName: overrides.customerName ?? "Search Probe",
        customerEmail: overrides.customerEmail ?? user.email,
        customerPhone: overrides.customerPhone ?? "03001112223",
        status: overrides.status ?? "PENDING",
        paymentMethod: "COD",
        paymentStatus: overrides.paymentStatus ?? "PENDING",
        isGuest: false,
        idempotencyKey: `idem-${ref}`,
        subtotal: 1000,
        deliveryFee: 0,
        total: 1000,
        shipFullName: "Search Probe",
        shipPhone: "03001112223",
        shipLine1: "1 Test Street",
        shipCity: "Lahore",
        shipProvince: "Punjab",
      },
    });
    return { user, order };
  }

  it("finds orders by reference fragment case-insensitively", async () => {
    const { user, order } = await seedSearchOrder({ reference: "KH2611PROBE01" });
    try {
      const lower = await adminListOrders({ q: "probe01" });
      expect(lower.items.some((o) => o.id === order.id)).toBe(true);

      const upper = await adminListOrders({ q: "PROBE01" });
      expect(upper.items.some((o) => o.id === order.id)).toBe(true);
    } finally {
      await db.order.delete({ where: { id: order.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it("matches customer name, email and phone fragments", async () => {
    const { user, order } = await seedSearchOrder({
      customerName: "Ayesha Siddiqui",
      customerEmail: "ayesha.siddiqui@example.com",
      customerPhone: "03214445556",
    });
    try {
      expect((await adminListOrders({ q: "ayesha sid" })).items.some((o) => o.id === order.id)).toBe(true);
      expect((await adminListOrders({ q: "AYESHA.SIDD" })).items.some((o) => o.id === order.id)).toBe(true);
      expect((await adminListOrders({ q: "4445556" })).items.some((o) => o.id === order.id)).toBe(true);
      // no false positives for unrelated terms
      expect((await adminListOrders({ q: "not-a-match-xyz" })).items.some((o) => o.id === order.id)).toBe(false);
    } finally {
      await db.order.delete({ where: { id: order.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it("combines status filter with search and paginates deterministically", async () => {
    const { user, order } = await seedSearchOrder({ status: "CONFIRMED" });
    try {
      const scoped = await adminListOrders({ status: "CONFIRMED", q: "search probe" });
      expect(scoped.items.some((o) => o.id === order.id)).toBe(true);

      const wrongStatus = await adminListOrders({ status: "DELIVERED", q: "search probe" });
      expect(wrongStatus.items.some((o) => o.id === order.id)).toBe(false);

      const paged = await adminListOrders({ q: "", page: 1 });
      expect(paged.page).toBe(1);
      expect(paged.pages).toBeGreaterThan(0);
      expect(paged.items.length).toBeLessThanOrEqual(15);
    } finally {
      await db.order.delete({ where: { id: order.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });

  it("filters by paymentStatus (M-31): failed payments are listable", async () => {
    const failed = await seedSearchOrder({ paymentStatus: "FAILED" });
    const paid = await seedSearchOrder({ paymentStatus: "PAID" });
    try {
      const failedList = await adminListOrders({ paymentStatus: "FAILED", q: "search probe" });
      expect(failedList.items.some((o) => o.id === failed.order.id)).toBe(true);
      expect(failedList.items.some((o) => o.id === paid.order.id)).toBe(false);
      expect(failedList.items.every((o) => o.paymentStatus === "FAILED")).toBe(true);

      const paidList = await adminListOrders({ paymentStatus: "PAID", q: "search probe" });
      expect(paidList.items.some((o) => o.id === paid.order.id)).toBe(true);
      expect(paidList.items.some((o) => o.id === failed.order.id)).toBe(false);

      // An unknown paymentStatus is ignored, not applied — a hand-crafted
      // query param must not empty the list by accident.
      const ignored = await adminListOrders({ paymentStatus: "BOGUS", q: "search probe" });
      expect(ignored.items.some((o) => o.id === failed.order.id)).toBe(true);
      expect(ignored.items.some((o) => o.id === paid.order.id)).toBe(true);
    } finally {
      await db.order.delete({ where: { id: failed.order.id } });
      await db.order.delete({ where: { id: paid.order.id } });
      await db.user.delete({ where: { id: failed.user.id } });
      await db.user.delete({ where: { id: paid.user.id } });
    }
  });
});

describe("order history pagination (Phase 3, chunk 12)", () => {
  it("clamps negative, zero and NaN pages to page 1 instead of 500ing", async () => {
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
    try {
      for (let i = 0; i < 3; i++) {
        await db.order.create({
          data: {
            reference: `KH-CLAMP-${randomUUID()}`,
            idempotencyKey: `clamp-${randomUUID()}`,
            userId: user.id,
            customerName: "Clamp",
            customerEmail: user.email,
            customerPhone: "0300",
            shipFullName: "Clamp",
            shipPhone: "0300",
            shipLine1: "Street",
            shipCity: "Lahore",
            shipProvince: "Punjab",
            subtotal: 100,
            total: 100,
          },
        });
      }

      // /account/orders?page=-5 used to pass skip=-60 to Prisma, which throws
      // and the page 500s. Negative, zero and NaN pages must behave as page 1.
      const negative = await getUserOrders(user.id, -5, 10);
      expect(negative.page).toBe(1);
      expect(negative.items).toHaveLength(3);

      const zero = await getUserOrders(user.id, 0, 10);
      expect(zero.page).toBe(1);
      expect(zero.items).toHaveLength(3);

      const nan = await getUserOrders(user.id, Number.NaN, 10);
      expect(nan.page).toBe(1);
      expect(nan.items).toHaveLength(3);

      // A genuine page 2 still works and reports itself.
      const second = await getUserOrders(user.id, 2, 2);
      expect(second.page).toBe(2);
      expect(second.pages).toBe(2);
      expect(second.items).toHaveLength(1);
    } finally {
      await db.order.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
});

describe("customer cancellation (Phase 3, chunk 2-final — H-11, D1/D2)", () => {
  it("restores stock, releases the coupon use, and marks the payment CANCELLED", async () => {
    const { product } = await seedProduct(3);
    const coupon = await db.coupon.create({
      data: { code: `CX${Date.now()}`, type: "PERCENT", value: 10, maxUses: 5 },
    });
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const placed = await placeOrder(checkoutInput(`cancel-cod-${coupon.code}`, coupon.code), checkoutUserId);
    expect(placed.ok).toBe(true);
    if (!placed.ok) throw new Error("placeOrder failed unexpectedly");
    expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(2);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);

    const result = await customerCancelOrder(placed.orderId, checkoutUserId, "Changed my mind");
    expect(result.ok).toBe(true);
    expect(result.order).toMatchObject({ status: "CANCELLED", paymentStatus: "CANCELLED" });

    expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(3);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
    const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(order.status).toBe("CANCELLED");
    expect(order.paymentStatus).toBe("CANCELLED");
    expect(order.cancelledAt).not.toBeNull();
    expect(order.cancelledBy).toBe(`customer:${checkoutUserId}`);
    expect(order.cancelReason).toBe("Changed my mind");
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: placed.orderId } });
    expect(payment.status).toBe("CANCELLED");
    await clearUserCart(checkoutUserId);
  });

  it("double-cancel is idempotent and restores stock exactly once", async () => {
    const { product } = await seedProduct(3);
    const order = await createOrderWithItems([product], [2], { userId: checkoutUserId });

    const results = await Promise.allSettled([
      customerCancelOrder(order.id, checkoutUserId),
      customerCancelOrder(order.id, checkoutUserId),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled" && r.value.ok);
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled.filter((r) => r.status === "fulfilled" && r.value.alreadyCancelled)).toHaveLength(1);

    expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(5);
    // A third, sequential cancel is idempotent too and changes nothing.
    const again = await customerCancelOrder(order.id, checkoutUserId);
    expect(again).toMatchObject({ ok: true, alreadyCancelled: true });
    expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(5);
  });

  it("refuses a non-owner with NOT_FOUND and a shipped order with INVALID_STATUS", async () => {
    const { product } = await seedProduct(3);
    const order = await createOrderWithItems([product], [1], { userId: checkoutUserId });
    const stranger = await db.user.create({ data: { email: `stranger-${Date.now()}@example.invalid` } });

    expect(await customerCancelOrder(order.id, stranger.id)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    // The refusal changed nothing.
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CONFIRMED");

    const shipped = await createOrderWithItems([product], [1], { userId: checkoutUserId, status: "SHIPPED" });
    expect(await customerCancelOrder(shipped.id, checkoutUserId)).toMatchObject({
      ok: false,
      code: "INVALID_STATUS",
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: shipped.id } })).status).toBe("SHIPPED");
    await db.user.delete({ where: { id: stranger.id } });
  });

  it("stores no reason when none is given, and cancels a PENDING order", async () => {
    const { product } = await seedProduct(3);
    const order = await createOrderWithItems([product], [1], { userId: checkoutUserId, status: "PENDING" });
    const result = await customerCancelOrder(order.id, checkoutUserId);
    expect(result.ok).toBe(true);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.cancelReason).toBeNull();
    expect(fresh.cancelledAt).not.toBeNull();
    expect(fresh.cancelledBy).toBe(`customer:${checkoutUserId}`);
  });

  it("admin cancel also sets CANCELLED payment status for COD and legacy ONLINE", async () => {
    const { product } = await seedProduct(3);
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const placed = await placeOrder(checkoutInput(`cancel-admin-cod-${Date.now()}`), checkoutUserId);
    expect(placed.ok).toBe(true);
    if (!placed.ok) throw new Error("placeOrder failed unexpectedly");
    expect((await adminUpdateOrderStatus(placed.orderId, "CANCELLED")).ok).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: placed.orderId } })).paymentStatus).toBe("CANCELLED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: placed.orderId } })).status).toBe("CANCELLED");

    // Legacy unpaid ONLINE order: its payment was never captured, so the
    // cancelled payment is CANCELLED (D2) — the old code marked it FAILED.
    const online = await createOrderWithItems([product], [1], {
      userId: checkoutUserId,
      paymentMethod: "ONLINE",
    });
    await db.payment.create({ data: { orderId: online.id, provider: "ONLINE", amount: 1000, status: "PENDING" } });
    expect((await adminUpdateOrderStatus(online.id, "CANCELLED")).ok).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: online.id } })).paymentStatus).toBe("CANCELLED");
    expect((await db.payment.findFirstOrThrow({ where: { orderId: online.id } })).status).toBe("CANCELLED");
    await clearUserCart(checkoutUserId);
  });
});

describe("COD minimum order total (Phase 3, chunk 2-final — D17)", () => {
  it("rejects a Rs 0 COD total (full coupon + free delivery) with MINIMUM_NOT_MET", async () => {
    const { product } = await seedProduct(4);
    const coupon = await db.coupon.create({
      data: { code: `FREE${Date.now()}`, type: "FIXED", value: 1000, maxUses: 5 },
    });
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const key = `cod-min-zero-${coupon.code}`;
    const result = await placeOrder(checkoutInput(key, coupon.code), checkoutUserId);
    expect(result).toMatchObject({ ok: false, code: "MINIMUM_NOT_MET" });
    expect(result).toMatchObject({ error: expect.stringContaining("Rs 1") });
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
    // The rejection rolls the coupon reservation back: no use is burned.
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
    await clearUserCart(checkoutUserId);
  });

  it("accepts a Rs 1 COD total", async () => {
    const { product } = await seedProduct(4);
    const coupon = await db.coupon.create({
      data: { code: `ONE${Date.now()}`, type: "FIXED", value: 999, maxUses: 5 },
    });
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 1 }]);
    const placed = await placeOrder(checkoutInput(`cod-min-one-${coupon.code}`, coupon.code), checkoutUserId);
    expect(placed.ok).toBe(true);
    if (!placed.ok) throw new Error("placeOrder failed unexpectedly");
    expect((await db.order.findUniqueOrThrow({ where: { id: placed.orderId } })).total).toBe(1);
    // Clean up so the accepted order does not hold stock for later tests.
    expect((await adminUpdateOrderStatus(placed.orderId, "CANCELLED")).ok).toBe(true);
    await clearUserCart(checkoutUserId);
  });
});

describe("M-4 (Stage 3 audit) — adminUpdateOrderStatus on a missing order", () => {
  it("returns NOT_FOUND for a nonexistent order", async () => {
    expect(await adminUpdateOrderStatus(randomUUID(), "CANCELLED")).toEqual({
      ok: false, error: "Order not found.", code: "NOT_FOUND",
    });
  });
});
