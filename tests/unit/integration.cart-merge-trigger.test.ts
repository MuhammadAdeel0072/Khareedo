// Integration test — cart merge trigger (Phase 3, Chunk 4-final, H-6/D7).
// Run with: npm run test:db
//
// Covers the merge TRIGGER (src/actions/cart.ts), not the merge rules
// themselves (those are H-7, covered by integration.cart.test.ts):
// - a signed-in customer landing with a guest cart gets it merged, the
//   guest cart row deleted, and the guest cookie actually cleared
//   (cookieCleared: true — the Server Action runs with a mutable cookie
//   store, unlike the checkout-page call site);
// - the trigger is idempotent (second call is a no-op, never duplicates
//   lines) and a no-op when there is no guest cart;
// - anonymous visitors get null and their guest cart is untouched.
// The cookies() mock is backed by a real in-memory jar so the
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

// The action reads the session through getSessionUser() (PR-25). Tests run
// as guests (no session) unless a test sets sessionUser.id.
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
import { GUEST_CART_COOKIE } from "@/lib/whatsapp";
import { mergeGuestCartAction } from "@/actions/cart";

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
    data: { name: `MergeCat-${suffix}`, slug: `mergecat-${suffix}`, isActive: true },
  });
  created.categories.push(category.id);
  const product = await db.product.create({
    data: {
      name: overrides.name ?? `Merge Watch ${suffix}`,
      slug: `merge-watch-${suffix}`,
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

describe("cart merge trigger (H-6/D7)", () => {
  it("merges the guest cart, deletes the guest row, and clears the cookie", async () => {
    const user = await seedUser();
    sessionUser.id = user.id;
    const inStock = await seedProduct(10, { name: "In Stock Watch" });
    const guestCart = await seedGuestCart([{ productId: inStock.id, quantity: 2 }]);

    const summary = await mergeGuestCartAction();

    expect(summary).not.toBeNull();
    expect(summary?.cookieCleared).toBe(true);
    expect(summary?.merged).toEqual([
      { productId: inStock.id, name: "In Stock Watch", quantity: 2 },
    ]);
    expect(summary?.skipped).toEqual([]);
    const items = await userCartItems(user.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.productId).toBe(inStock.id);
    expect(items[0]?.quantity).toBe(2);
    // Guest cart row deleted and the cookie cleared.
    expect(await db.cart.findUnique({ where: { id: guestCart.id } })).toBeNull();
    expect(cookieJar.values.get(GUEST_CART_COOKIE)).toBeUndefined();
  });

  it("skips unavailable lines with a reason and merges the rest", async () => {
    const user = await seedUser();
    sessionUser.id = user.id;
    const plenty = await seedProduct(30, { name: "Plenty Watch" });
    const soldOut = await seedProduct(0, { name: "Sold Out Watch" });
    const draft = await seedProduct(5, { name: "Draft Watch", status: "DRAFT" });
    await seedGuestCart([
      { productId: plenty.id, quantity: 25 },
      { productId: soldOut.id, quantity: 1 },
      { productId: draft.id, quantity: 1 },
    ]);

    const summary = await mergeGuestCartAction();

    expect(summary?.cookieCleared).toBe(true);
    // 25 requested, clamped to the API cap of 20.
    expect(summary?.merged).toEqual([
      { productId: plenty.id, name: "Plenty Watch", quantity: 20 },
    ]);
    expect(summary?.skipped).toEqual([
      { productId: soldOut.id, name: "Sold Out Watch", reason: "out_of_stock" },
      { productId: draft.id, name: "Draft Watch", reason: "unavailable" },
    ]);
    const items = await userCartItems(user.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(20);
  });

  it("is idempotent: a second trigger call is a no-op and never duplicates lines", async () => {
    const user = await seedUser();
    sessionUser.id = user.id;
    const product = await seedProduct(10, { name: "Once Watch" });
    await seedGuestCart([{ productId: product.id, quantity: 2 }]);

    const first = await mergeGuestCartAction();
    expect(first?.merged).toHaveLength(1);
    // The cookie is gone after the first call, so the second call finds
    // nothing to merge — even if the cookie were somehow still present,
    // the guest cart row is deleted, so the result is the same.
    const second = await mergeGuestCartAction();
    expect(second).toEqual({ merged: [], skipped: [], cookieCleared: false });
    const items = await userCartItems(user.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(2);
  });

  it("is a no-op when there is no guest cart, and clears a stale cookie", async () => {
    const user = await seedUser();
    sessionUser.id = user.id;

    // No cookie at all.
    expect(await mergeGuestCartAction()).toEqual({
      merged: [],
      skipped: [],
      cookieCleared: false,
    });
    expect(await db.cart.findUnique({ where: { userId: user.id } })).toBeNull();

    // Cookie pointing at a deleted cart: nothing to merge, but the stale
    // cookie is cleared while we are here.
    cookieJar.values.set(GUEST_CART_COOKIE, `guest-${randomUUID()}`);
    expect(await mergeGuestCartAction()).toEqual({
      merged: [],
      skipped: [],
      cookieCleared: true,
    });
    expect(cookieJar.values.get(GUEST_CART_COOKIE)).toBeUndefined();
  });

  it("returns null for anonymous visitors and leaves the guest cart untouched", async () => {
    const product = await seedProduct(10, { name: "Guest Watch" });
    const guestCart = await seedGuestCart([{ productId: product.id, quantity: 3 }]);
    const key = cookieJar.values.get(GUEST_CART_COOKIE);

    expect(await mergeGuestCartAction()).toBeNull();

    expect(await db.cart.findUnique({ where: { id: guestCart.id } })).not.toBeNull();
    expect(cookieJar.values.get(GUEST_CART_COOKIE)).toBe(key);
  });
});
