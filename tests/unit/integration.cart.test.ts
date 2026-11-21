// Integration test — cart merge and consistency (Phase 3, Chunk 4). Run with:
// npm run test:db
//
// Covers H-7 (validated guest→user merge: deleted/inactive/out-of-stock
// lines skipped, quantities clamped to stock and the API cap of 20, guest
// cookie cleared, merge summary returned), M-12 (transactional add/update —
// concurrent adds cannot oversell) and M-13 (stale lines dropped on load
// and reported) against the real Prisma layer on a disposable SQLite
// database. The cookies() mock is backed by a real in-memory jar so the
// cookie-clearing behaviour is asserted, not assumed.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const cookieJar = vi.hoisted(() => ({ values: new Map<string, string>() }));
const sessionUser = vi.hoisted(() => ({ id: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.values.get(name);
      return value ? { value } : undefined;
    },
    set: (name: string, value: string) => {
      cookieJar.values.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.values.delete(name);
    },
  }),
}));

// Cart paths read the session through getSessionUser() (PR-25). All tests
// here run as guests (no session) unless a test sets sessionUser.id.
vi.mock("@/lib/auth-guard", () => ({
  getSessionUser: async () => (sessionUser.id ? { id: sessionUser.id } : null),
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
import { PATCH as patchCart } from "@/app/api/cart/route";
import { GUEST_CART_COOKIE } from "@/lib/whatsapp";
import {
  addToCart,
  applyCartItemUpdate,
  getCartDetailsForCart,
  mergeGuestCart,
  pruneStaleGuestCarts,
} from "@/services/cart.service";

assertDisposableTestDatabase();

const created = {
  products: [] as string[],
  categories: [] as string[],
  carts: [] as string[],
  users: [] as string[],
};

async function seedProduct(
  stock: number,
  overrides: Partial<{
    name: string;
    status: string;
    deletedAt: Date | null;
  }> = {}
) {
  const suffix = randomUUID();
  const category = await db.category.create({
    data: { name: `CartCat-${suffix}`, slug: `cartcat-${suffix}`, isActive: true },
  });
  created.categories.push(category.id);
  const product = await db.product.create({
    data: {
      name: overrides.name ?? `Cart Watch ${suffix}`,
      slug: `cart-watch-${suffix}`,
      price: 1000,
      status: overrides.status ?? "PUBLISHED",
      deletedAt: overrides.deletedAt ?? null,
      categoryId: category.id,
      inventory: { create: { quantity: stock } },
    },
  });
  created.products.push(product.id);
  return product;
}

async function seedGuestCart(
  lines: Array<{ productId: string; quantity: number; giftWrap?: boolean }>
) {
  const key = `guest-${randomUUID()}`;
  cookieJar.values.set(GUEST_CART_COOKIE, key);
  const cart = await db.cart.create({
    data: {
      sessionKey: key,
      items: {
        create: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          giftWrap: line.giftWrap ?? false,
        })),
      },
    },
  });
  created.carts.push(cart.id);
  return cart;
}

async function seedUser(email?: string) {
  const user = await db.user.create({
    data: { email: email ?? `${randomUUID()}@example.test` },
  });
  created.users.push(user.id);
  return user;
}

async function userCartItems(userId: string) {
  const cart = await db.cart.findUnique({
    where: { userId },
    include: { items: true },
  });
  return cart?.items ?? [];
}

beforeEach(() => {
  cookieJar.values.clear();
  sessionUser.id = "";
});

afterAll(async () => {
  await db.cartItem.deleteMany({ where: { cartId: { in: created.carts } } });
  await db.cart.deleteMany({ where: { id: { in: created.carts } } });
  await db.cartItem.deleteMany({ where: { cart: { userId: { in: created.users } } } });
  await db.cart.deleteMany({ where: { userId: { in: created.users } } });
  await db.product.deleteMany({ where: { id: { in: created.products } } });
  await db.category.deleteMany({ where: { id: { in: created.categories } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

describe("guest-cart merge (H-7)", () => {
  it("merges valid lines, clamps to stock and the API cap, and skips invalid lines", async () => {
    const user = await seedUser();
    const lowStock = await seedProduct(3, { name: "Low Stock Watch" });
    const plenty = await seedProduct(30, { name: "Plenty Watch" });
    const soldOut = await seedProduct(0, { name: "Sold Out Watch" });
    const draft = await seedProduct(5, { name: "Draft Watch", status: "DRAFT" });
    const deleted = await seedProduct(5, {
      name: "Deleted Watch",
      deletedAt: new Date(0),
    });
    const guestCart = await seedGuestCart([
      { productId: lowStock.id, quantity: 5 },
      { productId: plenty.id, quantity: 25 },
      { productId: soldOut.id, quantity: 1 },
      { productId: draft.id, quantity: 1 },
      { productId: deleted.id, quantity: 1 },
    ]);

    const summary = await mergeGuestCart(user.id);

    expect(summary.merged).toEqual([
      { productId: lowStock.id, name: "Low Stock Watch", quantity: 3 },
      { productId: plenty.id, name: "Plenty Watch", quantity: 20 },
    ]);
    expect(summary.skipped).toEqual([
      { productId: soldOut.id, name: "Sold Out Watch", reason: "out_of_stock" },
      { productId: draft.id, name: "Draft Watch", reason: "unavailable" },
      { productId: deleted.id, name: "Deleted Watch", reason: "unavailable" },
    ]);
    expect(summary.cookieCleared).toBe(true);
    expect(cookieJar.values.has(GUEST_CART_COOKIE)).toBe(false);
    expect(await db.cart.findUnique({ where: { id: guestCart.id } })).toBeNull();
    expect(await userCartItems(user.id)).toMatchObject([
      { productId: lowStock.id, quantity: 3 },
      { productId: plenty.id, quantity: 20 },
    ]);
  });

  it("merges into an existing user line clamped to stock and the cap", async () => {
    const user = await seedUser();
    const product = await seedProduct(30, { name: "Shared Watch" });
    const userCart = await db.cart.create({
      data: {
        userId: user.id,
        items: { create: { productId: product.id, quantity: 18 } },
      },
    });
    created.carts.push(userCart.id);
    await seedGuestCart([{ productId: product.id, quantity: 5 }]);

    const summary = await mergeGuestCart(user.id);

    expect(summary.merged).toEqual([
      { productId: product.id, name: "Shared Watch", quantity: 2 },
    ]);
    expect(summary.skipped).toEqual([]);
    expect(await userCartItems(user.id)).toMatchObject([
      { productId: product.id, quantity: 20 },
    ]);
  });

  it("skips a line already at the cap instead of exceeding it", async () => {
    const user = await seedUser();
    const product = await seedProduct(30, { name: "Capped Watch" });
    const userCart = await db.cart.create({
      data: {
        userId: user.id,
        items: { create: { productId: product.id, quantity: 20 } },
      },
    });
    created.carts.push(userCart.id);
    await seedGuestCart([{ productId: product.id, quantity: 5 }]);

    const summary = await mergeGuestCart(user.id);

    expect(summary.merged).toEqual([]);
    expect(summary.skipped).toEqual([
      { productId: product.id, name: "Capped Watch", reason: "already_in_cart" },
    ]);
    expect(await userCartItems(user.id)).toMatchObject([
      { productId: product.id, quantity: 20 },
    ]);
  });

  it("returns an empty summary and clears a stale cookie when there is nothing to merge", async () => {
    const user = await seedUser();
    cookieJar.values.set(GUEST_CART_COOKIE, `stale-${randomUUID()}`);

    const summary = await mergeGuestCart(user.id);

    expect(summary).toEqual({ merged: [], skipped: [], cookieCleared: true });
    expect(cookieJar.values.has(GUEST_CART_COOKIE)).toBe(false);
    expect(await db.cart.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it("does nothing without a guest cookie", async () => {
    const user = await seedUser();

    const summary = await mergeGuestCart(user.id);

    expect(summary).toEqual({ merged: [], skipped: [], cookieCleared: false });
    expect(await db.cart.findUnique({ where: { userId: user.id } })).toBeNull();
  });
});

describe("transactional add/update (M-12)", () => {
  it("concurrent adds cannot oversell", async () => {
    const product = await seedProduct(5, { name: "Race Watch" });
    await seedGuestCart([]);

    const results = await Promise.allSettled([
      addToCart(product.id, 3),
      addToCart(product.id, 3),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: "Only 5 unit(s) available in stock",
    });
    const items = await db.cartItem.findMany({
      where: { cart: { sessionKey: cookieJar.values.get(GUEST_CART_COOKIE) } },
    });
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(3);
  });

  it("apply-update throws on overstock and leaves the line unchanged", async () => {
    const product = await seedProduct(3, { name: "Update Watch" });
    const guestCart = await seedGuestCart([{ productId: product.id, quantity: 1 }]);
    const item = await db.cartItem.findFirstOrThrow({ where: { cartId: guestCart.id } });

    await expect(applyCartItemUpdate(item.id, { quantity: 4 })).rejects.toThrow(
      "Only 3 unit(s) available in stock"
    );
    expect((await db.cartItem.findUniqueOrThrow({ where: { id: item.id } })).quantity).toBe(1);
  });
});

describe("stale-line cleanup on load (M-13)", () => {
  it("drops deleted, inactive and out-of-stock lines on load and reports them", async () => {
    const live = await seedProduct(3, { name: "Live Watch" });
    const soldOut = await seedProduct(0, { name: "Gone Watch" });
    const draft = await seedProduct(5, { name: "Draft Watch", status: "DRAFT" });
    const deleted = await seedProduct(5, {
      name: "Deleted Watch",
      deletedAt: new Date(0),
    });
    const cart = await seedGuestCart([
      { productId: live.id, quantity: 2 },
      { productId: soldOut.id, quantity: 1 },
      { productId: draft.id, quantity: 1 },
      { productId: deleted.id, quantity: 1 },
    ]);

    const details = await getCartDetailsForCart(cart.id);

    expect(details.items.map((item) => item.productId)).toEqual([live.id]);
    expect(details.removed.map((line) => line.productId).sort()).toEqual(
      [soldOut.id, draft.id, deleted.id].sort()
    );
    expect(details.removed.map((line) => line.name).sort()).toEqual(
      ["Deleted Watch", "Draft Watch", "Gone Watch"].sort()
    );
    expect(await db.cartItem.count({ where: { cartId: cart.id } })).toBe(1);
    // Second load: nothing left to remove.
    expect((await getCartDetailsForCart(cart.id)).removed).toEqual([]);
  });

  it("keeps a partially stocked line clamped instead of dropping it", async () => {
    const product = await seedProduct(3, { name: "Partial Watch" });
    const cart = await seedGuestCart([{ productId: product.id, quantity: 3 }]);
    await db.inventory.updateMany({
      where: { productId: product.id, variantId: null },
      data: { quantity: 1 },
    });

    const details = await getCartDetailsForCart(cart.id);

    expect(details.items).toHaveLength(1);
    expect(details.items[0]).toMatchObject({ productId: product.id, quantity: 1, stock: 1 });
    expect(details.removed).toEqual([]);
    expect(await db.cartItem.count({ where: { cartId: cart.id } })).toBe(1);
  });
});

describe("cart PATCH route (real handler, chunk 12 follow-up B)", () => {
  // The dead updateCartItem was removed; this pins the real PATCH path —
  // the route handler through applyCartItemUpdate — instead of the deleted
  // duplicate.
  it("updates quantity and gift wrap through PATCH, rejects overstock, and deletes at quantity 0", async () => {
    const product = await seedProduct(5, { name: "Patch Watch" });
    const guestCart = await seedGuestCart([{ productId: product.id, quantity: 1 }]);
    const item = await db.cartItem.findFirstOrThrow({ where: { cartId: guestCart.id } });

    const patch = async (body: unknown) => {
      const res = await patchCart(
        new Request("http://localhost/api/cart", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    const updated = await patch({ itemId: item.id, quantity: 3, giftWrap: true });
    expect(updated.status).toBe(200);
    expect(updated.body.cart.items[0]).toMatchObject({ quantity: 3, giftWrap: true });
    expect(updated.body.cart.wrappedUnits).toBe(3);

    const overstock = await patch({ itemId: item.id, quantity: 6 });
    expect(overstock.status).toBe(409);
    expect(overstock.body.error).toContain("Only 5 unit(s) available in stock");
    expect((await db.cartItem.findUniqueOrThrow({ where: { id: item.id } })).quantity).toBe(3);

    const deleted = await patch({ itemId: item.id, quantity: 0 });
    expect(deleted.status).toBe(200);
    expect(deleted.body.cart.items).toHaveLength(0);
    expect(await db.cartItem.findUnique({ where: { id: item.id } })).toBeNull();
  });
});

describe("stale guest-cart pruning (chunk 12 follow-up B)", () => {
  it("deletes guest carts older than 30 days with their lines, and keeps fresh guest carts and user carts", async () => {
    const product = await seedProduct(5, { name: "Prune Watch" });
    const staleGuest = await seedGuestCart([{ productId: product.id, quantity: 1 }]);
    const freshGuest = await seedGuestCart([{ productId: product.id, quantity: 1 }]);
    const user = await seedUser();
    const staleUserCart = await db.cart.create({
      data: {
        userId: user.id,
        items: { create: [{ productId: product.id, quantity: 1 }] },
      },
    });
    created.carts.push(staleUserCart.id);

    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await db.cart.update({ where: { id: staleGuest.id }, data: { updatedAt: old } });
    await db.cart.update({ where: { id: staleUserCart.id }, data: { updatedAt: old } });

    const result = await pruneStaleGuestCarts();
    expect(result.deleted).toBe(1);
    expect(await db.cart.findUnique({ where: { id: staleGuest.id } })).toBeNull();
    expect(await db.cartItem.findMany({ where: { cartId: staleGuest.id } })).toHaveLength(0);
    expect(await db.cart.findUnique({ where: { id: freshGuest.id } })).not.toBeNull();
    expect(await db.cart.findUnique({ where: { id: staleUserCart.id } })).not.toBeNull();
  });
});
