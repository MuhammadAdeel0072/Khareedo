// Cart service — persistent carts for guests (sessionKey cookie) and customers
// (FR-14..18, FR-16 server-side subtotal, BR-04).
import { cache } from "react";
import { db } from "@/lib/db";
import { cookies } from "next/headers";
import { GUEST_CART_COOKIE, newGuestCartKey } from "@/lib/whatsapp";
import { getRequestSession } from "@/lib/auth-guard";
import type { CartItemDetail } from "@/types/cart";

export interface CartOwner {
  userId?: string;
  sessionKey?: string;
}

/**
 * Resolve the cart for the current visitor.
 * Priority: user cart (when signed in) → guest cookie cart.
 * NOTE: cookie writes happen only in route handlers / server actions.
 */
export async function resolveCart(create = false): Promise<{ id: string; isGuest: boolean } | null> {
  // 1) try signed-in user
  const session = await getRequestSession();
  if (session?.user?.id) {
    const cart = await db.cart.findUnique({ where: { userId: session.user.id } });
    if (cart) return { id: cart.id, isGuest: false };
    if (!create) return null;
    const created = await db.cart.create({ data: { userId: session.user.id } });
    return { id: created.id, isGuest: false };
  }

  // 2) guest cookie cart
  const store = await cookies();
  const key = store.get(GUEST_CART_COOKIE)?.value;
  if (key) {
    const cart = await db.cart.findUnique({ where: { sessionKey: key } });
    if (cart) return { id: cart.id, isGuest: true };
    if (create) {
      const created = await db.cart.create({ data: { sessionKey: key } });
      return { id: created.id, isGuest: true };
    }
    return null;
  }

  if (!create) return null;
  // create new guest key (caller must persist via Set-Cookie from route handler)
  const newKey = newGuestCartKey();
  const created = await db.cart.create({ data: { sessionKey: newKey } });
  store.set(GUEST_CART_COOKIE, newKey, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return { id: created.id, isGuest: true };
}

export interface CartDetails {
  id: string;
  items: CartItemDetail[];
  itemCount: number;
  subtotal: number;
  wrappedUnits: number;
}

/** Fetch cart with CURRENT DB prices (FR-16, BR-04) — browser prices are ignored. */
export const getCartDetails = cache(async (): Promise<CartDetails | null> => {
  const cart = await resolveCart(false);
  if (!cart) return null;

  const rows = await db.cartItem.findMany({
    where: { cartId: cart.id },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          price: true,
          comparePrice: true,
          status: true,
          deletedAt: true,
          images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } },
          inventory: { select: { quantity: true, lowStockThreshold: true } },
        },
      },
    },
  });

  // Skip items whose product became unpublished/archived (FR-13)
  const items: CartItemDetail[] = [];
  let subtotal = 0;
  let itemCount = 0;
  let wrappedUnits = 0;
  for (const row of rows) {
    const p = row.product;
    if (p.status !== "PUBLISHED" || p.deletedAt) continue;
    const stock = p.inventory?.quantity ?? 0;
    const quantity = Math.min(row.quantity, Math.max(0, stock));
    const lineTotal = p.price * quantity;
    items.push({
      itemId: row.id,
      productId: p.id,
      name: p.name,
      slug: p.slug,
      price: p.price,
      comparePrice: p.comparePrice,
      image: p.images[0]?.url ?? null,
      quantity: row.quantity,
      stock,
      lowStock: stock > 0 && stock <= (p.inventory?.lowStockThreshold ?? 5),
      outOfStock: stock <= 0,
      lineTotal,
      priceChanged: false,
      giftWrap: row.giftWrap,
    });
    subtotal += lineTotal;
    itemCount += quantity;
    if (row.giftWrap && stock > 0) wrappedUnits += Math.min(row.quantity, Math.max(0, stock));
  }

  return { id: cart.id, items, itemCount, subtotal, wrappedUnits };
});

export async function getCartCount(): Promise<number> {
  const details = await getCartDetails();
  return details?.itemCount ?? 0;
}

export async function addToCart(productId: string, quantity: number) {
  const cart = await resolveCart(true);
  if (!cart) throw new Error("Could not create cart");

  const product = await db.product.findFirst({
    where: { id: productId, status: "PUBLISHED", deletedAt: null },
    include: { inventory: true },
  });
  if (!product) throw new Error("This product is not available");
  const stock = product.inventory?.quantity ?? 0;
  if (stock <= 0) throw new Error("Sorry, this product is out of stock");

  const existing = await db.cartItem.findUnique({
    where: { cartId_productId: { cartId: cart.id, productId } },
  });
  const desired = Math.min((existing?.quantity ?? 0) + Math.max(1, quantity), stock);
  if (existing) {
    await db.cartItem.update({ where: { id: existing.id }, data: { quantity: desired } });
  } else {
    await db.cartItem.create({
      data: { cartId: cart.id, productId, quantity: Math.min(Math.max(1, quantity), stock) },
    });
  }
  return getCartDetails();
}

export async function updateCartItem(itemId: string, quantity: number) {
  const cart = await resolveCart(false);
  if (!cart) throw new Error("Cart not found");
  const item = await db.cartItem.findFirst({
    where: { id: itemId, cartId: cart.id },
    include: { product: { include: { inventory: true } } },
  });
  if (!item) throw new Error("Cart item not found");

  if (quantity <= 0) {
    await db.cartItem.delete({ where: { id: itemId } });
    return getCartDetails();
  }
  const stock = item.product.inventory?.quantity ?? 0;
  if (quantity > stock) throw new Error(`Only ${stock} unit(s) available in stock`);
  await db.cartItem.update({ where: { id: itemId }, data: { quantity } });
  return getCartDetails();
}

export async function removeCartItem(itemId: string) {
  const cart = await resolveCart(false);
  if (!cart) throw new Error("Cart not found");
  await db.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
  return getCartDetails();
}

/** Toggle gift wrapping on ONE cart line — the wrap flag lives on the item, not the order. */
export async function setCartItemGiftWrap(itemId: string, wrap: boolean) {
  const cart = await resolveCart(false);
  if (!cart) throw new Error("Cart not found");
  const item = await db.cartItem.findFirst({
    where: { id: itemId, cartId: cart.id },
    select: { id: true },
  });
  if (!item) throw new Error("Cart item not found");
  await db.cartItem.update({ where: { id: item.id }, data: { giftWrap: wrap } });
  return getCartDetails();
}

/** Empty the cart (after successful order placement). */
export async function clearCart() {
  const cart = await resolveCart(false);
  if (!cart) return;
  await db.cartItem.deleteMany({ where: { cartId: cart.id } });
}

/** Merge a guest cart into the user cart after sign-in (FR-17 continuity). */
export async function mergeGuestCart(userId: string) {
  const store = await cookies();
  const key = store.get(GUEST_CART_COOKIE)?.value;
  if (!key) return;
  const guestCart = await db.cart.findUnique({
    where: { sessionKey: key },
    include: { items: true },
  });
  if (!guestCart) return;
  const userCart = await db.cart.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  for (const item of guestCart.items) {
    const existing = await db.cartItem.findUnique({
      where: { cartId_productId: { cartId: userCart.id, productId: item.productId } },
    });
    if (existing) {
      await db.cartItem.update({
        where: { id: existing.id },
        data: {
          quantity: Math.min(existing.quantity + item.quantity, 99),
          giftWrap: existing.giftWrap || item.giftWrap,
        },
      });
    } else {
      await db.cartItem.create({
        data: {
          cartId: userCart.id,
          productId: item.productId,
          quantity: item.quantity,
          giftWrap: item.giftWrap,
        },
      });
    }
  }
  await db.cart.delete({ where: { id: guestCart.id } }).catch(() => undefined);
  store.delete(GUEST_CART_COOKIE);
}
