// Cart service — persistent carts for guests (sessionKey cookie) and customers
// (FR-14..18, FR-16 server-side subtotal, BR-04).
import { cache } from "react";
import { db } from "@/lib/db";
import { cookies } from "next/headers";
import { GUEST_CART_COOKIE, newGuestCartKey } from "@/lib/whatsapp";
import { getRequestSession } from "@/lib/auth-guard";
import type { CartItemDetail } from "@/types/cart";
import {
  getPerformanceRequestId,
  withPerformanceMeasurement,
  withPerformanceTiming,
} from "@/lib/performance-timing";

export interface CartOwner {
  userId?: string;
  sessionKey?: string;
}

/**
 * Resolve the cart for the current visitor.
 * Priority: user cart (when signed in) → guest cookie cart.
 * NOTE: cookie writes happen only in route handlers / server actions.
 */
const resolveExistingCart = cache(async () =>
  withPerformanceTiming("cart.resolve", () => resolveCartImpl(false))
);

export async function resolveCart(
  create = false
): Promise<{ id: string; isGuest: boolean } | null> {
  if (!create) {
    return resolveExistingCart();
  }

  return withPerformanceTiming("cart.resolve", () => resolveCartImpl(true));
}

async function resolveCartImpl(create: boolean): Promise<{ id: string; isGuest: boolean } | null> {
  // 1) try signed-in user
  const session = await getRequestSession();
  if (session?.user?.id) {
    const cart = await db.cart.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (cart) return { id: cart.id, isGuest: false };
    if (!create) return null;
    const created = await db.cart.create({
      data: { userId: session.user.id },
      select: { id: true },
    });
    return { id: created.id, isGuest: false };
  }

  // 2) guest cookie cart
  const store = await cookies();
  const key = store.get(GUEST_CART_COOKIE)?.value;
  if (key) {
    const cart = await db.cart.findUnique({
      where: { sessionKey: key },
      select: { id: true },
    });
    if (cart) return { id: cart.id, isGuest: true };
    if (create) {
      const created = await db.cart.create({
        data: { sessionKey: key },
        select: { id: true },
      });
      return { id: created.id, isGuest: true };
    }
    return null;
  }

  if (!create) return null;
  // create new guest key (caller must persist via Set-Cookie from route handler)
  const newKey = newGuestCartKey();
  const created = await db.cart.create({
    data: { sessionKey: newKey },
    select: { id: true },
  });
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


interface CartJoinedRow {
  itemId: string;
  productId: string;
  quantity: number;
  giftWrap: boolean;
  name: string;
  slug: string;
  price: number;
  comparePrice: number | null;
  status: string;
  isDeleted: boolean | number;
  image: string | null;
  stock: number | null;
  lowStockThreshold: number | null;
}


/** Fetch cart with CURRENT DB prices (FR-16, BR-04) — browser prices are ignored. */


async function getCartDetailsForCart(
  cartId: string
): Promise<CartDetails> {
  return withPerformanceTiming("cart.details", async () => {
    // One parameterized SQL query retrieves cart items,
    // products, stock and the first product image.
    const rows = await db.$queryRaw<CartJoinedRow[]>`
      SELECT
        ci."id" AS "itemId",
        ci."productId",
        ci."quantity",
        ci."giftWrap",
        p."name",
        p."slug",
        p."price",
        p."comparePrice",
        p."status",
        (p."deletedAt" IS NOT NULL) AS "isDeleted",
        i."quantity" AS "stock",
        i."lowStockThreshold",
        (
          SELECT img."url"
          FROM "ProductImage" AS img
          WHERE img."productId" = p."id"
          ORDER BY img."sortOrder" ASC
          LIMIT 1
        ) AS "image"
      FROM "CartItem" AS ci
      JOIN "Product" AS p
        ON p."id" = ci."productId"
      LEFT JOIN "Inventory" AS i
        ON i."productId" = p."id"
      WHERE ci."cartId" = ${cartId}
    `;

    const items: CartItemDetail[] = [];
    let subtotal = 0;
    let itemCount = 0;
    let wrappedUnits = 0;

    for (const row of rows) {
      // Preserve existing product visibility rules.
      if (
        row.status !== "PUBLISHED" ||
        row.isDeleted
      ) {
        continue;
      }

      const stock = row.stock ?? 0;

      // Clamp the effective quantity to available stock.
      const effectiveQuantity = Math.min(
        row.quantity,
        Math.max(0, stock)
      );

      // Always calculate totals from current DB prices.
      const lineTotal =
        row.price * effectiveQuantity;

      items.push({
        itemId: row.itemId,
        productId: row.productId,
        name: row.name,
        slug: row.slug,
        price: row.price,
        comparePrice: row.comparePrice,
        image: row.image,
        quantity: row.quantity,
        stock,
        lowStock:
          stock > 0 &&
          stock <= (row.lowStockThreshold ?? 5),
        outOfStock: stock <= 0,
        lineTotal,
        priceChanged: false,
        giftWrap: row.giftWrap,
      });

      subtotal += lineTotal;
      itemCount += effectiveQuantity;

      if (row.giftWrap && stock > 0) {
        wrappedUnits += effectiveQuantity;
      }
    }

    return {
      id: cartId,
      items,
      itemCount,
      subtotal,
      wrappedUnits,
    };
  });
}


export const getCartDetails = cache(
  async (): Promise<CartDetails | null> => {
    const cart = await resolveCart(false);
    if (!cart) return null;

    return getCartDetailsForCart(cart.id);
  }
);


export async function getCartCount(): Promise<number> {
  const requestId = getPerformanceRequestId();
  return withPerformanceTiming("cart.count", async () => {
    const session = await withPerformanceMeasurement(
      "cart.count.session",
      getRequestSession,
      requestId
    );
    const cartOwner = await withPerformanceMeasurement(
      "cart.count.owner",
      async () => {
        const guestCartKey = session?.user?.id
          ? undefined
          : (await cookies()).get(GUEST_CART_COOKIE)?.value;
        return session?.user?.id
          ? { kind: "user" as const, id: session.user.id }
          : guestCartKey
            ? { kind: "guest" as const, id: guestCartKey }
            : null;
      },
      requestId
    );

    if (!cartOwner) return 0;

    const rows = await withPerformanceMeasurement(
      "cart.count.query",
      () => db.$queryRaw<Array<{
          quantity: number;
          status: string;
          isDeleted: boolean | number;
          stock: number | null;
        }>>`
          SELECT item."quantity", p."status", (p."deletedAt" IS NOT NULL) AS "isDeleted",
                 i."quantity" AS "stock"
          FROM "Cart" AS cart
          JOIN "CartItem" AS item ON item."cartId" = cart."id"
          JOIN "Product" AS p ON p."id" = item."productId"
          LEFT JOIN "Inventory" AS i ON i."productId" = p."id"
          WHERE (${cartOwner.kind === "user"} = TRUE AND cart."userId" = ${cartOwner.id})
             OR (${cartOwner.kind === "guest"} = TRUE AND cart."sessionKey" = ${cartOwner.id})
        `,
      requestId
    );

    return withPerformanceMeasurement(
      "cart.count.reduce",
      () =>
        rows.reduce((count, row) => {
          if (row.status !== "PUBLISHED" || row.isDeleted) return count;
          const stock = row.stock ?? 0;
          return count + Math.min(row.quantity, Math.max(0, stock));
        }, 0),
      requestId
    );
  }, requestId);
}

async function getCartItemCount(cartId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{
    quantity: number;
    status: string;
    isDeleted: boolean | number;
    stock: number | null;
  }>>`
    SELECT item."quantity", p."status", (p."deletedAt" IS NOT NULL) AS "isDeleted",
           i."quantity" AS "stock"
    FROM "CartItem" AS item
    JOIN "Product" AS p ON p."id" = item."productId"
    LEFT JOIN "Inventory" AS i ON i."productId" = p."id"
    WHERE item."cartId" = ${cartId}
  `;

  return rows.reduce((count, row) => {
    if (row.status !== "PUBLISHED" || row.isDeleted) return count;
    const stock = row.stock ?? 0;
    return count + Math.min(row.quantity, Math.max(0, stock));
  }, 0);
}

export async function addToCart(productId: string, quantity: number) {
  return withPerformanceTiming("cart.add", async () => {
    const cart = await resolveCart(true);
    if (!cart) throw new Error("Could not create cart");

    const product = await db.product.findFirst({
      where: { id: productId, status: "PUBLISHED", deletedAt: null },
      select: { inventory: { select: { quantity: true } } },
    });
    if (!product) throw new Error("This product is not available");
    const stock = product.inventory?.quantity ?? 0;
    if (stock <= 0) throw new Error("Sorry, this product is out of stock");

    const existing = await db.cartItem.findUnique({
      where: { cartId_productId: { cartId: cart.id, productId } },
      select: { id: true, quantity: true },
    });
    const desired = Math.min((existing?.quantity ?? 0) + Math.max(1, quantity), stock);
    if (existing) {
      await db.cartItem.update({ where: { id: existing.id }, data: { quantity: desired } });
    } else {
      await db.cartItem.create({
        data: { cartId: cart.id, productId, quantity: Math.min(Math.max(1, quantity), stock) },
      });
    }

    return {
      itemCount: await withPerformanceTiming("cart.count", () => getCartItemCount(cart.id)),
    };
  });
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
    return getCartDetailsForCart(cart.id);
  }
  const stock = item.product.inventory?.quantity ?? 0;
  if (quantity > stock) throw new Error(`Only ${stock} unit(s) available in stock`);
  await db.cartItem.update({ where: { id: itemId }, data: { quantity } });
  return getCartDetailsForCart(cart.id);
}

export async function removeCartItem(itemId: string) {
  const cart = await resolveCart(false);
  if (!cart) throw new Error("Cart not found");
  await db.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
  return getCartDetailsForCart(cart.id);
}

/** Toggle gift wrapping on ONE cart line — the wrap flag lives on the item, not the order. */
export async function setCartItemGiftWrap(itemId: string, wrap: boolean) {
  return applyCartItemUpdate(itemId, { giftWrap: wrap });
}

/** Apply quantity and/or gift-wrap to ONE line with a single details re-fetch
 *  (the PATCH route previously ran two full cart-detail queries when both
 *  fields were sent together). Quantity semantics match updateCartItem:
 *  <= 0 deletes the line; above stock throws. */
export async function applyCartItemUpdate(
  itemId: string,
  patch: { quantity?: number; giftWrap?: boolean }
) {
  const cart = await resolveCart(false);
  if (!cart) throw new Error("Cart not found");
  const item = await db.cartItem.findFirst({
    where: { id: itemId, cartId: cart.id },
    include: { product: { include: { inventory: true } } },
  });
  if (!item) throw new Error("Cart item not found");

  if (patch.quantity !== undefined && patch.quantity <= 0) {
    await db.cartItem.delete({ where: { id: item.id } });
    return getCartDetailsForCart(cart.id);
  }
  if (patch.quantity !== undefined) {
    const stock = item.product.inventory?.quantity ?? 0;
    if (patch.quantity > stock) throw new Error(`Only ${stock} unit(s) available in stock`);
  }
  if (patch.giftWrap !== undefined || patch.quantity !== undefined) {
    await db.cartItem.update({
      where: { id: item.id },
      data: {
        ...(patch.giftWrap !== undefined ? { giftWrap: patch.giftWrap } : {}),
        ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
      },
    });
  }
  return getCartDetailsForCart(cart.id);
}

/** Empty the cart (after successful order placement). */
export async function clearCart(cartId: string) {
  await db.cartItem.deleteMany({ where: { cartId } });
}

/** Merge a guest cart into the user cart after sign-in (FR-17 continuity).
 *
 *  Performance notes: the guest-cart read happens OUTSIDE the transaction so
 *  the common repeat case (cookie left over after an earlier merge — nothing
 *  to merge) returns without opening a transaction at all. When there IS
 *  something to merge, existing user-cart lines are prefetched once and merge
 *  decisions run in memory instead of one findUnique per guest line.
 */
export async function mergeGuestCart(userId: string) {
  const store = await cookies();
  const key = store.get(GUEST_CART_COOKIE)?.value;
  if (!key) return;

  const guestCart = await db.cart.findUnique({
    where: { sessionKey: key },
    include: { items: true },
  });
  if (!guestCart || guestCart.items.length === 0) return;

  // Collapse duplicate guest lines for the same product in memory so the
  // unique(cartId, productId) constraint can never be violated by createMany.
  const guestLines = new Map<
    string,
    { productId: string; quantity: number; giftWrap: boolean }
  >();
  for (const item of guestCart.items) {
    const prev = guestLines.get(item.productId);
    guestLines.set(
      item.productId,
      prev
        ? {
            productId: item.productId,
            quantity: Math.min(prev.quantity + item.quantity, 99),
            giftWrap: prev.giftWrap || item.giftWrap,
          }
        : {
            productId: item.productId,
            quantity: item.quantity,
            giftWrap: item.giftWrap,
          }
    );
  }

  await db.$transaction(async tx => {
    const userCart = await tx.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
    const existingItems = await tx.cartItem.findMany({
      where: { cartId: userCart.id },
      select: { id: true, productId: true, quantity: true, giftWrap: true },
    });
    const byProductId = new Map(existingItems.map((i) => [i.productId, i]));

    const toCreate: {
      cartId: string;
      productId: string;
      quantity: number;
      giftWrap: boolean;
    }[] = [];
    for (const item of guestLines.values()) {
      const existing = byProductId.get(item.productId);
      if (existing) {
        await tx.cartItem.update({
          where: { id: existing.id },
          data: {
            quantity: Math.min(existing.quantity + item.quantity, 99),
            giftWrap: existing.giftWrap || item.giftWrap,
          },
        });
      } else {
        toCreate.push({
          cartId: userCart.id,
          productId: item.productId,
          quantity: item.quantity,
          giftWrap: item.giftWrap,
        });
      }
    }
    if (toCreate.length > 0) {
      await tx.cartItem.createMany({ data: toCreate });
    }
    await tx.cart.delete({ where: { id: guestCart.id } });
  });
}
