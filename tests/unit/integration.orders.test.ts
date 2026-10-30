// Integration tests — order placement, idempotency & stock consistency against a
// throwaway SQLite database (FR-18, FR-27, BR-05/08/11, NFR-07).
// Run with: npm run test:db
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

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
import { adminUpdateOrderStatus } from "@/services/orders.service";
import { adminListProducts, listProducts } from "@/services/products.service";
import * as cartService from "@/services/cart.service";
import * as settingsService from "@/services/settings.service";

// These tests run only through the disposable SQLite test harness. They exercise
// the real Prisma layer and never use the application's configured database:
//   • unique idempotencyKey constraint (duplicate orders blocked)
//   • order + items + payment created atomically
//   • inventory decremented exactly once
assertDisposableTestDatabase();

const KEY = `test-idem-${Date.now()}`;

async function seedProduct(
  stock: number,
  overrides: Partial<{
    name: string;
    description: string;
    brand: string | null;
    tags: string | null;
  }> = {}
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cat = await db.category.create({
    data: { name: `TestCat-${suffix}`, slug: `testcat-${suffix}`, isActive: true },
  });
  const product = await db.product.create({
    data: {
      name: overrides.name ?? "Integration Test Watch",
      slug: `test-watch-${suffix}`,
      description: overrides.description ?? "test",
      brand: overrides.brand,
      tags: overrides.tags,
      categoryId: cat.id,
      price: 1000,
      status: "PUBLISHED",
      inventory: { create: { quantity: stock } },
      images: { create: { url: "/images/placeholder.svg", sortOrder: 0 } },
    },
    include: { inventory: true },
  });
  return { cat, product };
}

function checkoutCart(product: { id: string; name: string; slug: string; price: number }, stock: number) {
  return {
    id: "mock-cart",
    itemCount: 1,
    subtotal: product.price,
    wrappedUnits: 0,
    items: [{
      itemId: "mock-cart-item",
      productId: product.id,
      name: product.name,
      slug: product.slug,
      price: product.price,
      comparePrice: null,
      image: null,
      quantity: 1,
      stock,
      lowStock: false,
      outOfStock: false,
      lineTotal: product.price,
      priceChanged: false,
      giftWrap: false,
    }],
  };
}

function checkoutInput(idempotencyKey: string, couponCode?: string) {
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
  quantities: number[]
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return db.order.create({
    data: {
      reference: `KHT${suffix}`,
      idempotencyKey: `cancel-test-${suffix}`,
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
      subtotal: 1000,
      total: 1000,
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
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(settingsService, "getSettings").mockResolvedValue({
    ...settingsService.DEFAULT_SETTINGS,
    cod_enabled: true,
    bank_transfer_enabled: false,
    online_payment_enabled: false,
    delivery_fee_standard: 0,
    delivery_fee_express: 0,
    free_delivery_threshold: 0,
    gift_wrap_enabled: false,
    gift_wrap_charge: 0,
  });
  vi.spyOn(cartService, "getCartDetails").mockResolvedValue(null);
  vi.spyOn(cartService, "clearCart").mockResolvedValue(undefined);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("order placement integrity", () => {
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

    const inv = await db.inventory.findUniqueOrThrow({ where: { productId: product.id } });
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
    const inv = await db.inventory.findUniqueOrThrow({ where: { productId: product.id } });
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

    const inventory = await db.inventory.findUniqueOrThrow({ where: { productId: product.id } });
    expect(inventory.quantity).toBe(5);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
    expect((await adminUpdateOrderStatus(order.id, "CANCELLED")).ok).toBe(false);
    expect((await db.inventory.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(5);
  });

  it("rolls back cancellation status and earlier stock restores if a linked product has no inventory", async () => {
    const first = await seedProduct(3);
    const second = await seedProduct(3);
    const order = await createOrderWithItems([first.product, second.product], [2, 1]);
    await db.inventory.delete({ where: { productId: second.product.id } });

    await expect(adminUpdateOrderStatus(order.id, "CANCELLED")).rejects.toThrow(
      "Unable to restore inventory"
    );

    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CONFIRMED");
    expect((await db.inventory.findUniqueOrThrow({ where: { productId: first.product.id } })).quantity).toBe(3);
    expect(await db.inventory.findUnique({ where: { productId: second.product.id } })).toBeNull();
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
    vi.mocked(cartService.getCartDetails).mockResolvedValue(checkoutCart(product, 4));
    const keys = [`coupon-race-a-${Date.now()}`, `coupon-race-b-${Date.now()}`];

    const results = await Promise.all(
      keys.map((key) => placeOrder(checkoutInput(key, couponCode)))
    );
    const orders = await db.order.findMany({ where: { idempotencyKey: { in: keys } } });
    const currentCoupon = await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } });

    expect(results.some((result) => result.ok)).toBe(true);
    expect(currentCoupon.usedCount).toBe(1);
    expect(orders.filter((order) => order.couponCode === couponCode)).toHaveLength(1);
    expect(orders.filter((order) => order.discountTotal > 0)).toHaveLength(1);
    for (const order of orders) {
      expect(order.discountTotal).toBe(order.couponCode ? 100 : 0);
    }
  });

  it("rolls coupon usage and order creation back when stock reservation fails", async () => {
    const { product } = await seedProduct(0);
    const couponCode = `ROLLBACK${Date.now()}`;
    const coupon = await db.coupon.create({
      data: { code: couponCode, type: "FIXED", value: 100, maxUses: 1 },
    });
    vi.mocked(cartService.getCartDetails).mockResolvedValue(checkoutCart(product, 1));
    const key = `coupon-rollback-${Date.now()}`;

    const result = await placeOrder(checkoutInput(key, couponCode));

    expect(result).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
  });

  it("stores coupon snapshot and matching discount on successful checkout", async () => {
    const { product } = await seedProduct(3);
    const couponCode = `SAVE${Date.now()}`;
    const coupon = await db.coupon.create({
      data: { code: couponCode, type: "PERCENT", value: 10, maxUses: 2 },
    });
    vi.mocked(cartService.getCartDetails).mockResolvedValue(checkoutCart(product, 3));
    const key = `coupon-success-${Date.now()}`;

    const result = await placeOrder(checkoutInput(key, couponCode));
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

  it("searches admin product names using mixed-case terms", async () => {
    const { product } = await seedProduct(1, { name: "adminCaseTokenProduct" });

    const result = await adminListProducts({ q: "ADMINCASETOKEN" });

    expect(result.items.some((item) => item.id === product.id)).toBe(true);
  });

  it("password hashing roundtrip (auth credentials never stored in plain text)", async () => {
    const hash = await bcrypt.hash("Test@1234", 12);
    expect(await bcrypt.compare("Test@1234", hash)).toBe(true);
    expect(await bcrypt.compare("WrongPass1", hash)).toBe(false);
    expect(hash).not.toContain("Test@1234");
  });
});
