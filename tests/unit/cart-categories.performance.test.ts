import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const visitor = vi.hoisted(() => ({ key: undefined as string | undefined, userId: undefined as string | undefined }));
vi.mock("@/lib/auth-guard", () => ({
  getRequestSession: async () => visitor.userId ? { user: { id: visitor.userId } } : null,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => visitor.key ? { value: visitor.key } : undefined }),
}));
vi.mock("@/lib/db", async () => {
  if (process.env.KHAREEDO_DISPOSABLE_SQLITE_TEST !== "1") return { db: {} };
  assertDisposableTestDatabase();
  const { PrismaClient } = await import("../../generated/sqlite-client");
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  return { db: client.$extends({ query: { $allOperations({ operation, args, query }) {
    if (operation === "$queryRaw" || operation === "$queryRawUnsafe" ||
        operation === "$executeRaw" || operation === "$executeRawUnsafe") return query(args);
    return query(args);
  } } }) };
});

import { db } from "@/lib/db";
import { addToCart, getCartCount, getCartDetails, removeCartItem, setCartItemGiftWrap, updateCartItem } from "@/services/cart.service";
import { getCategoryTree, getCategoriesWithCounts } from "@/services/categories.service";

// Real SQL tests are opt-in through a marked temporary database, never .env.
describe.skipIf(process.env.KHAREEDO_DISPOSABLE_SQLITE_TEST !== "1")("cart/category read equivalence", () => {
  beforeAll(() => assertDisposableTestDatabase());
  beforeEach(() => { visitor.key = undefined; visitor.userId = undefined; });
  afterAll(async () => { await db.$disconnect(); });

  async function guestCart(id?: string) {
    visitor.key = randomUUID();
    return db.cart.create({ data: { id, sessionKey: visitor.key } });
  }

  async function product(overrides: {
    id?: string; price?: number; stock?: number | null; status?: string; deletedAt?: Date;
    threshold?: number; categoryId?: string;
  } = {}) {
    const suffix = randomUUID();
    const categoryId = overrides.categoryId ?? (await db.category.create({
      data: { name: suffix, slug: suffix, isActive: true },
    })).id;
    return db.product.create({ data: {
      id: overrides.id, name: `Watch ${suffix}`, slug: suffix, categoryId,
      price: overrides.price ?? 1250, comparePrice: 1500,
      status: overrides.status ?? "PUBLISHED", deletedAt: overrides.deletedAt,
      ...(overrides.stock === null ? {} : { inventory: { create: {
        quantity: overrides.stock ?? 3, lowStockThreshold: overrides.threshold ?? 4,
      } } }),
      images: { create: [{ url: "/later.png", sortOrder: 8 }, { url: "/first.png", sortOrder: 1 }] },
    } });
  }

  it("does not create a cart for a visitor without a cart cookie", async () => {
    const before = await db.cart.count();
    expect(await getCartDetails()).toBeNull();
    expect(await getCartCount()).toBe(0);
    expect(await db.cart.count()).toBe(before);
  });

  it("keeps missing and empty guest cart results distinct", async () => {
    visitor.key = randomUUID();
    expect(await getCartDetails()).toBeNull();
    const cart = await guestCart();
    expect(await getCartDetails()).toEqual({ id: cart.id, items: [], itemCount: 0, subtotal: 0, wrappedUnits: 0 });
    expect(await getCartCount()).toBe(0);
  });

  it("preserves current prices, stock clamps, wrapping, line order and visibility", async () => {
    const cart = await guestCart();
    const wrapped = await product();
    const normal = await product({ price: 100, stock: 10, threshold: 0 });
    const soldOut = await product({ stock: 0 });
    const noInventory = await product({ stock: null });
    const draft = await product({ status: "DRAFT" });
    const deleted = await product({ deletedAt: new Date(0) });
    for (const [p, quantity, giftWrap] of [
      [wrapped, 8, true], [normal, 2, false], [soldOut, 2, true],
      [noInventory, 2, true], [draft, 2, true], [deleted, 2, true],
    ] as const) await db.cartItem.create({ data: { cartId: cart.id, productId: p.id, quantity, giftWrap } });
    const originalOrder = await db.cartItem.findMany({ where: { cartId: cart.id } });
    const details = await getCartDetails();
    expect(details).toMatchObject({ id: cart.id, itemCount: 5, subtotal: 3950, wrappedUnits: 3 });
    expect(details!.items.map(item => item.productId)).toEqual(originalOrder
      .filter(item => item.productId !== draft.id && item.productId !== deleted.id).map(item => item.productId));
    expect(details!.items.find(item => item.productId === wrapped.id)).toEqual({
      itemId: originalOrder.find(item => item.productId === wrapped.id)!.id,
      productId: wrapped.id, name: wrapped.name, slug: wrapped.slug,
      price: 1250, comparePrice: 1500, image: "/first.png", quantity: 8,
      stock: 3, lowStock: true, outOfStock: false, lineTotal: 3750, priceChanged: false, giftWrap: true,
    });
    expect(details!.items.find(item => item.productId === normal.id)).toMatchObject({ lowStock: false, lineTotal: 200 });
    for (const id of [soldOut.id, noInventory.id]) {
      expect(details!.items.find(item => item.productId === id)).toMatchObject({ quantity: 2, stock: 0, outOfStock: true, lowStock: false, lineTotal: 0 });
    }
    expect(await getCartCount()).toBe(details!.itemCount);
    expect(await addToCart(normal.id, 99)).toEqual({ itemCount: 13 });
  });

  it("reads updated prices and inventory instead of a global customer cache", async () => {
    const cart = await guestCart();
    const p = await product();
    await db.cartItem.create({ data: { cartId: cart.id, productId: p.id, quantity: 3, giftWrap: true } });
    expect((await getCartDetails())!.subtotal).toBe(3750);
    await db.product.update({ where: { id: p.id }, data: { price: 2000 } });
    await db.inventory.update({ where: { productId: p.id }, data: { quantity: 1 } });
    expect(await getCartDetails()).toMatchObject({ subtotal: 2000, itemCount: 1, wrappedUnits: 1 });
    expect(await getCartCount()).toBe(1);
  });

  it("keeps the signed-in cart ahead of a guest cookie and isolates users", async () => {
    const guest = await guestCart();
    const p = await product({ stock: 10 });
    await db.cartItem.create({ data: { cartId: guest.id, productId: p.id, quantity: 7 } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
    const userCart = await db.cart.create({ data: { userId: user.id, items: { create: { productId: p.id, quantity: 2 } } } });
    visitor.userId = user.id;
    expect((await getCartDetails())!.id).toBe(userCart.id);
    expect(await getCartCount()).toBe(2);
    visitor.userId = (await db.user.create({ data: { email: `${randomUUID()}@example.test` } })).id;
    expect(await getCartDetails()).toBeNull();
    expect(await getCartCount()).toBe(0);
  });

  it("authenticates verified test customers and rejects wrong passwords or unverified email", async () => {
    const password = randomUUID();
    const user = await db.user.create({ data: {
      email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash(password, 12),
      emailVerified: new Date(), role: "CUSTOMER",
    } });
    const { authOptions } = await import("@/lib/auth");
    const provider = authOptions.providers.find(provider => typeof provider !== "function" && provider.type === "credentials");
    if (!provider || typeof provider === "function" || provider.type !== "credentials" || !provider.options?.authorize) {
      throw new Error("Credentials provider is not configured");
    }
    const authorize = provider.options.authorize;
    const request = {} as Parameters<typeof authorize>[1];
    expect(await authorize({ email: user.email.toUpperCase(), password }, request)).toMatchObject({ id: user.id, role: "CUSTOMER" });
    expect(await authorize({ email: user.email, password: randomUUID() }, request)).toBeNull();
    await db.user.update({ where: { id: user.id }, data: { emailVerified: null } });
    expect(await authorize({ email: user.email, password }, request)).toBeNull();
  });

  it("preserves the compact add response, quantity validation, wrapping and removal", async () => {
    const cart = await guestCart();
    const p = await product();
    expect(await addToCart(p.id, 2)).toEqual({ itemCount: 2 });
    const item = await db.cartItem.findFirstOrThrow({ where: { cartId: cart.id } });
    await expect(updateCartItem(item.id, 4)).rejects.toThrow("Only 3 unit(s) available in stock");
    expect(await setCartItemGiftWrap(item.id, true)).toMatchObject({ wrappedUnits: 2 });
    expect(await updateCartItem(item.id, 1)).toMatchObject({ itemCount: 1, wrappedUnits: 1 });
    expect(await removeCartItem(item.id)).toMatchObject({ items: [], itemCount: 0, subtotal: 0 });
  });

  it("retains cart ownership checks for updates and deletion", async () => {
    const other = await guestCart();
    const p = await product();
    const item = await db.cartItem.create({ data: { cartId: other.id, productId: p.id, quantity: 1 } });
    await guestCart();
    await expect(updateCartItem(item.id, 1)).rejects.toThrow("Cart item not found");
    await expect(setCartItemGiftWrap(item.id, true)).rejects.toThrow("Cart item not found");
    await removeCartItem(item.id);
    expect(await db.cartItem.findUnique({ where: { id: item.id } })).not.toBeNull();
  });

  it("binds quote-containing cart and product IDs as SQL parameters", async () => {
    const cart = await guestCart(`cart'-${randomUUID()}`);
    const p = await product({ id: `product') OR 1=1 -- ${randomUUID()}` });
    await db.cartItem.create({ data: { cartId: cart.id, productId: p.id, quantity: 1 } });
    expect((await getCartDetails())!.items.map(item => item.productId)).toEqual([p.id]);
    expect(await addToCart(p.id, 1)).toEqual({ itemCount: 2 });
  });

  it("does not truncate large carts when product reads are batched", async () => {
    const cart = await guestCart();
    const suffix = randomUUID();
    const category = await db.category.create({ data: { name: suffix, slug: suffix } });
    const products = Array.from({ length: 1001 }, (_, index) => ({
      id: `${suffix}-${index}`, name: `Bulk ${index}`, slug: `${suffix}-${index}`,
      categoryId: category.id, price: 10, status: "PUBLISHED",
    }));
    await db.product.createMany({ data: products });
    await db.cartItem.createMany({ data: products.map(p => ({ cartId: cart.id, productId: p.id, quantity: 1 })) });
    const details = await getCartDetails();
    expect(details!.items).toHaveLength(1001);
    expect(details!.itemCount).toBe(0); // Missing inventory remains unavailable.
    expect(new Set(details!.items.map(item => item.productId))).toEqual(new Set(products.map(p => p.id)));
  });

  it("preserves active roots, direct-child sorting and the existing two-level navigation", async () => {
    const suffix = randomUUID();
    const root = await db.category.create({ data: { name: "Root", slug: `root-${suffix}`, sortOrder: 5 } });
    const first = await db.category.create({ data: { name: "First", slug: `first-${suffix}`, sortOrder: 1, parentId: root.id, description: "Description", imageUrl: "/child.png" } });
    const last = await db.category.create({ data: { name: "Last", slug: `last-${suffix}`, sortOrder: 9, parentId: root.id } });
    await db.category.create({ data: { name: "Hidden", slug: `hidden-${suffix}`, sortOrder: 0, parentId: root.id, isActive: false } });
    await db.category.create({ data: { name: "Grandchild", slug: `grand-${suffix}`, parentId: first.id } });
    const inactive = await db.category.create({ data: { name: "Inactive", slug: `inactive-${suffix}`, isActive: false } });
    const orphan = await db.category.create({ data: { name: "Orphan", slug: `orphan-${suffix}`, parentId: inactive.id } });
    const tree = await getCategoryTree();
    const node = tree.find(category => category.id === root.id)!;
    expect(node.children.map(child => child.id)).toEqual([first.id, last.id]);
    expect(node.children[0]).toEqual({ id: first.id, name: "First", slug: first.slug, description: "Description", imageUrl: "/child.png", children: [] });
    expect(tree.some(category => category.id === inactive.id || category.id === orphan.id)).toBe(false);
  });

  it("keeps published, nondeleted product counts used by category filters", async () => {
    const suffix = randomUUID();
    const active = await db.category.create({ data: { name: suffix, slug: suffix } });
    await product({ categoryId: active.id });
    await product({ categoryId: active.id, status: "DRAFT" });
    await product({ categoryId: active.id, deletedAt: new Date(0) });
    const empty = await db.category.create({ data: { name: `empty-${suffix}`, slug: `empty-${suffix}` } });
    const list = await getCategoriesWithCounts();
    expect(list.find(category => category.id === active.id)?.productCount).toBe(1);
    expect(list.some(category => category.id === empty.id)).toBe(false);
  });
});
