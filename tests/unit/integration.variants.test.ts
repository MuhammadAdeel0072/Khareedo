// Integration tests — product variants (Phase 3, chunk 8, D12) against a
// throwaway SQLite database. Run with: npm run test:db
//
// Coverage: variant CRUD validation (duplicate SKU, product-SKU collision,
// wrong-product variant), per-(product, variant) cart lines, COD place with
// two variants (override + inherit, snapshots, per-variant decrements),
// whole-order rejection on an unavailable variant, concurrent last-unit
// race per variant, no-variant regression, cancel restock per variant,
// guest-cart merge carrying variantIds, import/export round-trip, and the
// partial unique indexes that keep null-variant rows unique.
//
// M-16 caveat (same as the Chunk 12 follow-up A race tests): SQLite
// serializes writers, so the race test asserts the no-lost-update invariant
// (exactly one order wins, the other gets OUT_OF_STOCK, the other variant's
// stock is untouched) — true interleaving proof needs Postgres.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const cartCookie = vi.hoisted(() => ({ guestKey: "" }));
const sessionUser = vi.hoisted(() => ({ id: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cartCookie.guestKey ? { value: cartCookie.guestKey } : undefined) }),
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
import { placeOrder } from "@/services/checkout.service";
import type { PlaceOrderInput } from "@/lib/validation";
import { addToCart, getCartDetailsForCart, mergeGuestCart } from "@/services/cart.service";
import { customerCancelOrder } from "@/services/orders.service";
import {
  createVariant,
  updateVariant,
  setVariantActive,
  listProductVariants,
  VariantSkuConflictError,
  VariantUnavailableError,
} from "@/services/variants.service";
import { adminUpdateInventory } from "@/services/inventory.service";
import { getProductsExportData } from "@/services/export.service";
import { parseProductsSheet } from "@/lib/import/products";
import { createSafepayPendingOrderService } from "@/services/safepay-pending-order.service";
import * as settingsService from "@/services/settings.service";
import { DEFAULT_SETTINGS } from "@/services/settings.service";

assertDisposableTestDatabase();

let checkoutUserId = "";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function seedUser(email?: string) {
  const user = await db.user.create({ data: { email: email ?? `variant-test-${suffix()}@example.invalid` } });
  return user.id;
}

/** Product with product-level stock 5 and two variants:
 *  A "Size: S" — absolute override 1500, stock 3.
 *  B "Size: M" — no override (inherits 1000), stock 2. */
async function seedVariantProduct() {
  const s = suffix();
  const cat = await db.category.create({ data: { name: `VariantCat-${s}`, slug: `variantcat-${s}`, isActive: true } });
  const product = await db.product.create({
    data: {
      name: `Variant Tee ${s}`,
      slug: `variant-tee-${s}`,
      description: "variant test product",
      categoryId: cat.id,
      price: 1000,
      status: "PUBLISHED",
      inventory: { create: { quantity: 5 } },
      images: { create: { url: "/images/placeholder.svg", sortOrder: 0 } },
    },
  });
  const variantA = await createVariant(product.id, {
    label: "Size: S",
    sku: `VAR-S-${s}`,
    priceOverride: 1500,
    stock: 3,
  });
  const variantB = await createVariant(product.id, {
    label: "Size: M",
    sku: `VAR-M-${s}`,
    priceOverride: null,
    stock: 2,
  });
  return { cat, product, variantA, variantB };
}

async function seedPlainProduct(stock: number) {
  const s = suffix();
  const cat = await db.category.create({ data: { name: `PlainCat-${s}`, slug: `plaincat-${s}`, isActive: true } });
  const product = await db.product.create({
    data: {
      name: `Plain Watch ${s}`,
      slug: `plain-watch-${s}`,
      description: "no-variant product",
      categoryId: cat.id,
      price: 1000,
      status: "PUBLISHED",
      inventory: { create: { quantity: stock } },
      images: { create: { url: "/images/placeholder.svg", sortOrder: 0 } },
    },
  });
  return { cat, product };
}

async function seedUserCart(
  userId: string,
  lines: Array<{ productId: string; variantId?: string | null; quantity: number; giftWrap?: boolean }>
) {
  await db.cartItem.deleteMany({ where: { cart: { userId } } });
  const cart = await db.cart.upsert({ where: { userId }, update: {}, create: { userId } });
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

async function stockOf(productId: string, variantId: string | null) {
  return (await db.inventory.findFirstOrThrow({ where: { productId, variantId } })).quantity;
}

function checkoutInput(idempotencyKey: string): PlaceOrderInput {
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
  };
}

beforeAll(async () => {
  checkoutUserId = await seedUser();
  sessionUser.id = checkoutUserId;
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
  // Chunk 7-final: order placement/cancel now enqueue customer emails in
  // the outbox. Remove this file's rows so later suites' small outbox
  // sweeps are not starved by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: { in: ["test@buyer.pk", "buyer@example.invalid"] } } });
  await db.$disconnect();
});

describe("variant CRUD validation (D12)", () => {
  it("rejects a duplicate variant SKU", async () => {
    const { product, variantA } = await seedVariantProduct();
    await expect(
      createVariant(product.id, { label: "Size: L", sku: variantA.sku, stock: 1 })
    ).rejects.toBeInstanceOf(VariantSkuConflictError);
  });

  it("rejects a variant SKU colliding with a product SKU", async () => {
    const { product } = await seedPlainProduct(5);
    const other = await seedPlainProduct(5);
    // The other product's own SKU is taken from its row (seeded without an
    // explicit sku, so use a product created with one).
    const skuProduct = await db.product.create({
      data: {
        name: `Sku Product ${suffix()}`,
        slug: `sku-product-${suffix()}`,
        description: "sku collision",
        categoryId: other.cat.id,
        price: 1000,
        sku: `PROD-SKU-${suffix()}`,
        status: "PUBLISHED",
        inventory: { create: { quantity: 1 } },
      },
    });
    await expect(
      createVariant(product.id, { label: "Size: S", sku: skuProduct.sku!, stock: 1 })
    ).rejects.toBeInstanceOf(VariantSkuConflictError);
  });

  it("rejects creating a variant for a missing product", async () => {
    await expect(
      createVariant(randomUUID(), { label: "Size: S", sku: `VAR-X-${suffix()}`, stock: 1 })
    ).rejects.toThrow("Product not found");
  });

  it("rejects updating a variant through the wrong product", async () => {
    const first = await seedVariantProduct();
    const second = await seedVariantProduct();
    await expect(
      updateVariant(second.product.id, first.variantA.id, { label: "Size: XS" })
    ).rejects.toBeInstanceOf(VariantUnavailableError);
  });

  it("deactivates a variant and listProductVariants hides it when activeOnly", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    await setVariantActive(product.id, variantA.id, false);
    const active = await listProductVariants(product.id, { activeOnly: true });
    expect(active.map((v) => v.id)).toEqual([variantB.id]);
    const all = await listProductVariants(product.id, { activeOnly: false });
    expect(all).toHaveLength(2);
  });
});

describe("cart lines are per (product, variant)", () => {
  it("merges the same variant, keeps different variants and no-variant lines separate", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    sessionUser.id = checkoutUserId;
    await addToCart(product.id, 1, variantA.id);
    await addToCart(product.id, 1, variantA.id);
    await addToCart(product.id, 1, variantB.id);
    await addToCart(product.id, 1);
    const cart = await db.cart.findUniqueOrThrow({ where: { userId: checkoutUserId } });
    const details = await getCartDetailsForCart(cart.id);
    expect(details!.items).toHaveLength(3);
    const byVariant = new Map(details!.items.map((i) => [i.variantId, i]));
    expect(byVariant.get(variantA.id)).toMatchObject({ quantity: 2, price: 1500, variantLabel: "Size: S" });
    expect(byVariant.get(variantB.id)).toMatchObject({ quantity: 1, price: 1000, variantLabel: "Size: M" });
    expect(byVariant.get(null)).toMatchObject({ quantity: 1, price: 1000, variantLabel: null });
  });

  it("rejects another product's variant and an inactive variant", async () => {
    const first = await seedVariantProduct();
    const second = await seedVariantProduct();
    await expect(addToCart(first.product.id, 1, second.variantA.id)).rejects.toThrow();
    await setVariantActive(first.product.id, first.variantA.id, false);
    await expect(addToCart(first.product.id, 1, first.variantA.id)).rejects.toThrow();
  });

  it("rejects adding more than the variant's stock", async () => {
    const { product, variantA } = await seedVariantProduct();
    await expect(addToCart(product.id, 4, variantA.id)).rejects.toThrow();
  });
});

describe("COD checkout with variants", () => {
  it("places an order with two variants: override + inherit, snapshots, per-variant decrements", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    await seedUserCart(checkoutUserId, [
      { productId: product.id, variantId: variantA.id, quantity: 2 },
      { productId: product.id, variantId: variantB.id, quantity: 1 },
    ]);
    const result = await placeOrder(checkoutInput(`variant-cod-${suffix()}`), checkoutUserId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected COD order to succeed: " + result.error);
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { items: true },
    });
    expect(order.total).toBe(2 * 1500 + 1 * 1000);
    expect(order.items).toHaveLength(2);
    const itemA = order.items.find((i) => i.variantId === variantA.id)!;
    expect(itemA).toMatchObject({ variantLabel: "Size: S", variantSku: variantA.sku, unitPrice: 1500, quantity: 2 });
    const itemB = order.items.find((i) => i.variantId === variantB.id)!;
    expect(itemB).toMatchObject({ variantLabel: "Size: M", variantSku: variantB.sku, unitPrice: 1000, quantity: 1 });
    // Per-variant stock decremented; the product-level row is untouched.
    expect(await stockOf(product.id, variantA.id)).toBe(1);
    expect(await stockOf(product.id, variantB.id)).toBe(1);
    expect(await stockOf(product.id, null)).toBe(5);
  });

  it("rejects the WHOLE order when one variant is out of stock", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    await adminUpdateInventory({ productId: product.id, variantId: variantB.id, quantity: 0 });
    await seedUserCart(checkoutUserId, [
      { productId: product.id, variantId: variantA.id, quantity: 1 },
      { productId: product.id, variantId: variantB.id, quantity: 1 },
    ]);
    const key = `variant-oos-${suffix()}`;
    const result = await placeOrder(checkoutInput(key), checkoutUserId);
    expect(result).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    // Nothing was decremented and no order was created for this key.
    expect(await stockOf(product.id, variantA.id)).toBe(3);
    expect(await stockOf(product.id, variantB.id)).toBe(0);
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0);
  });

  it("rejects the whole order when a variant was deactivated after adding to cart", async () => {
    const { product, variantA } = await seedVariantProduct();
    await seedUserCart(checkoutUserId, [{ productId: product.id, variantId: variantA.id, quantity: 1 }]);
    await setVariantActive(product.id, variantA.id, false);
    const result = await placeOrder(checkoutInput(`variant-deact-${suffix()}`), checkoutUserId);
    expect(result).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
  });

  it("no-variant regression: an existing product orders exactly as before", async () => {
    const { product } = await seedPlainProduct(4);
    await seedUserCart(checkoutUserId, [{ productId: product.id, quantity: 2 }]);
    const result = await placeOrder(checkoutInput(`variant-plain-${suffix()}`), checkoutUserId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected plain order to succeed: " + result.error);
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId }, include: { items: true } });
    expect(order.total).toBe(2000);
    expect(order.items[0]).toMatchObject({ variantId: null, variantLabel: null, variantSku: null, unitPrice: 1000 });
    expect(await stockOf(product.id, null)).toBe(2);
  });

  it("concurrent last-unit race per variant: one wins, the other gets OUT_OF_STOCK, the other variant is unaffected", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    await adminUpdateInventory({ productId: product.id, variantId: variantA.id, quantity: 1 });
    const userA = await seedUser();
    const userB = await seedUser();
    await seedUserCart(userA, [{ productId: product.id, variantId: variantA.id, quantity: 1 }]);
    await seedUserCart(userB, [{ productId: product.id, variantId: variantA.id, quantity: 1 }]);
    const [first, second] = await Promise.all([
      placeOrder(checkoutInput(`variant-race-a-${suffix()}`), userA),
      placeOrder(checkoutInput(`variant-race-b-${suffix()}`), userB),
    ]);
    const outcomes = [first.ok, second.ok].sort();
    expect(outcomes).toEqual([false, true]);
    const loser = first.ok ? second : first;
    expect(loser).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    expect(await stockOf(product.id, variantA.id)).toBe(0);
    // Variant B was never contested.
    expect(await stockOf(product.id, variantB.id)).toBe(2);
    expect(await stockOf(product.id, null)).toBe(5);
  });

  it("cancelling a variant COD order restores the variant's stock, not the product-level row", async () => {
    const { product, variantA } = await seedVariantProduct();
    await seedUserCart(checkoutUserId, [{ productId: product.id, variantId: variantA.id, quantity: 2 }]);
    const result = await placeOrder(checkoutInput(`variant-cancel-${suffix()}`), checkoutUserId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected COD order to succeed: " + result.error);
    expect(await stockOf(product.id, variantA.id)).toBe(1);
    const cancelled = await customerCancelOrder(result.orderId, checkoutUserId, "changed my mind");
    expect(cancelled.ok).toBe(true);
    expect(await stockOf(product.id, variantA.id)).toBe(3);
    expect(await stockOf(product.id, null)).toBe(5);
  });
});

describe("guest-cart merge carries variantIds", () => {
  it("merges a variant line onto the same variant and skips a gone variant with a reason", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    const userId = await seedUser();
    // The user already has variant B in their cart.
    await seedUserCart(userId, [{ productId: product.id, variantId: variantB.id, quantity: 1 }]);
    // The guest cart has variant A (new) and variant B (merge onto existing).
    const guestKey = `guest-${randomUUID()}`;
    cartCookie.guestKey = guestKey;
    await db.cart.create({
      data: {
        sessionKey: guestKey,
        items: {
          create: [
            { productId: product.id, variantId: variantA.id, quantity: 2 },
            { productId: product.id, variantId: variantB.id, quantity: 1 },
          ],
        },
      },
    });
    const summary = await mergeGuestCart(userId);
    expect(summary.merged.map((m) => m.name).sort()).toEqual([
      `${product.name} (Size: M)`,
      `${product.name} (Size: S)`,
    ]);
    expect(summary.skipped).toEqual([]);
    const cart = await db.cart.findUniqueOrThrow({ where: { userId } });
    const details = await getCartDetailsForCart(cart.id);
    const byVariant = new Map(details!.items.map((i) => [i.variantId, i]));
    expect(byVariant.get(variantA.id)).toMatchObject({ quantity: 2 });
    expect(byVariant.get(variantB.id)).toMatchObject({ quantity: 2 });

    // A guest line whose variant was deactivated is skipped, never
    // converted to a no-variant line.
    const guestKey2 = `guest-${randomUUID()}`;
    cartCookie.guestKey = guestKey2;
    await setVariantActive(product.id, variantA.id, false);
    await db.cart.create({
      data: {
        sessionKey: guestKey2,
        items: { create: [{ productId: product.id, variantId: variantA.id, quantity: 1 }] },
      },
    });
    const summary2 = await mergeGuestCart(userId);
    expect(summary2.skipped).toHaveLength(1);
    expect(summary2.skipped[0]).toMatchObject({ reason: "unavailable" });
    expect(summary2.skipped[0].name).toContain("Size: S");
  });
});

describe("Safepay pending order with variants", () => {
  it("holds stock against the variant rows and snapshots variant pricing", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    const userId = await seedUser();
    const cart = await seedUserCart(userId, [
      { productId: product.id, variantId: variantA.id, quantity: 1 },
      { productId: product.id, variantId: variantB.id, quantity: 1 },
    ]);
    const pending = createSafepayPendingOrderService({
      database: db as never,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, delivery_fee_standard: 0, gift_wrap_charge: 0 }),
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
      reservationTtlMs: 600_000,
      now: () => new Date(),
    });
    const result = await pending(
      {
        idempotencyKey: randomUUID(),
        paymentMethod: "ONLINE" as const,
        deliveryMethod: "STANDARD" as const,
        customer: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "03001234567" },
        address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" },
      },
      { cartId: cart.id, owner: { kind: "USER", userId } }
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected Safepay pending order: " + result.code);
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { items: { include: { inventoryReservation: true } } },
    });
    expect(order.total).toBe(1500 + 1000);
    const itemA = order.items.find((i) => i.variantId === variantA.id)!;
    expect(itemA).toMatchObject({ variantLabel: "Size: S", unitPrice: 1500 });
    const itemB = order.items.find((i) => i.variantId === variantB.id)!;
    expect(itemB).toMatchObject({ variantLabel: "Size: M", unitPrice: 1000 });
    // Holds sit on the variant rows, and available stock dropped by 1 each.
    const rowA = await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: variantA.id } });
    const rowB = await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: variantB.id } });
    expect(itemA.inventoryReservation!.inventoryId).toBe(rowA.id);
    expect(itemB.inventoryReservation!.inventoryId).toBe(rowB.id);
    expect(await stockOf(product.id, variantA.id)).toBe(2);
    expect(await stockOf(product.id, variantB.id)).toBe(1);
    expect(await stockOf(product.id, null)).toBe(5);
  });
});

describe("import/export round-trip with variants", () => {
  it("parses variant rows (same product name, one row per variant) and rejects a label without a SKU", () => {
    const s = suffix();
    const parsed = parseProductsSheet([
      { rowNumber: 1, cells: ["Name", "Category", "Price", "Stock", "Variant Label", "Variant SKU", "Variant Price", "Variant Stock"] },
      { rowNumber: 2, cells: [`Tee ${s}`, "Apparel", 1000, 0, "Size: S", `TS-${s}-S`, 1500, 3] },
      { rowNumber: 3, cells: [`Tee ${s}`, "Apparel", 1000, 0, "Size: M", `TS-${s}-M`, "", 2] },
      { rowNumber: 4, cells: [`Tee ${s}`, "Apparel", 1000, 0, "Size: L", "", "", 1] },
    ]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ variantLabel: "Size: S", variantSku: `TS-${s}-S`, variantPrice: 1500, variantStock: 3 });
    expect(parsed.rows[1]).toMatchObject({ variantLabel: "Size: M", variantSku: `TS-${s}-M`, variantPrice: null, variantStock: 2 });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].message).toContain("both Variant Label and Variant SKU");
  });

  it("exports one row per variant with label, SKU, override price and stock", async () => {
    const { product, variantA, variantB } = await seedVariantProduct();
    const rows = (await getProductsExportData(500)).filter((r) => r.name === product.name);
    expect(rows).toHaveLength(3);
    const byLabel = new Map(rows.map((r) => [r.variantLabel, r]));
    expect(byLabel.get("Size: S")).toMatchObject({ variantSku: variantA.sku, variantPrice: 1500, stock: 3 });
    expect(byLabel.get("Size: M")).toMatchObject({ variantSku: variantB.sku, variantPrice: null, stock: 2 });
    expect(byLabel.get("")).toMatchObject({ variantSku: "", variantPrice: null, stock: 5 });
  });
});

describe("partial unique indexes (Chunk 8)", () => {
  it("rejects a duplicate null-variant cart line and a duplicate variant cart line", async () => {
    const { product, variantA } = await seedVariantProduct();
    const cart = await db.cart.create({ data: { userId: await seedUser() } });
    await expect(
      db.cartItem.createMany({
        data: [
          { cartId: cart.id, productId: product.id, variantId: null, quantity: 1 },
          { cartId: cart.id, productId: product.id, variantId: null, quantity: 1 },
        ],
      })
    ).rejects.toThrow();
    await expect(
      db.cartItem.createMany({
        data: [
          { cartId: cart.id, productId: product.id, variantId: variantA.id, quantity: 1 },
          { cartId: cart.id, productId: product.id, variantId: variantA.id, quantity: 1 },
        ],
      })
    ).rejects.toThrow();
  });
});
