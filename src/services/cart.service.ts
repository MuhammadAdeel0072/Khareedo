// Cart service — persistent carts for guests (sessionKey cookie) and customers
// (FR-14..18, FR-16 server-side subtotal, BR-04).
import { cache } from "react";
import { db } from "@/lib/db";
import { cookies } from "next/headers";
import { GUEST_CART_COOKIE, newGuestCartKey } from "@/lib/whatsapp";
import { isHttpsDeployment } from "@/lib/site-url";
import { getSessionUser } from "@/lib/auth-guard";
import { getVariantForLine, inventoryForVariant } from "@/services/variants.service";
import type { CartItemDetail, GuestCartMergeSummary } from "@/types/cart";
import {
  getPerformanceRequestId,
  withPerformanceMeasurement,
  withPerformanceTiming,
} from "@/lib/performance-timing";

export interface CartOwner {
  userId?: string;
  sessionKey?: string;
}

/** The cart API caps a single add/update at 20 units (src/app/api/cart/route.ts);
 *  the merge clamps to the same ceiling so a merged line can never hold more
 *  than the API would ever let a customer add (Phase 3, H-7). */
export const CART_API_MAX_QUANTITY = 20;

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
  // 1) try signed-in user. This goes through getSessionUser() (PR-25), not
  // the raw session: the guard rejects sessions invalidated by a password
  // reset, so an invalidated session falls through to the guest path
  // instead of reaching the user's cart.
  const user = await getSessionUser();
  if (user?.id) {
    const cart = await db.cart.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (cart) return { id: cart.id, isGuest: false };
    if (!create) return null;
    const created = await db.cart.create({
      data: { userId: user.id },
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
    // Secure over HTTPS deployments (Phase 2, area F — H-3-G1, guest-cart
    // half): the cookie is a bearer token for the guest cart, and without
    // Secure it would travel in the clear on an HTTPS site. Over plain
    // HTTP (dev/preview) Secure would silently break the guest cart, so
    // the flag follows the deployment signal, like the session cookie.
    secure: isHttpsDeployment(),
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
  /** Lines removed from the stored cart on this load (M-13) — mirrors
   *  src/types/cart.ts CartDetails, which client components use. */
  removed: { productId: string; name: string }[];
}


interface CartJoinedRow {
  itemId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  giftWrap: boolean;
  name: string;
  slug: string;
  price: number;
  comparePrice: number | null;
  status: string;
  isDeleted: boolean | number;
  variantLabel: string | null;
  variantPrice: number | null;
  variantMissing: boolean | number;
  variantActive: boolean | number | null;
  image: string | null;
  stock: number | null;
  lowStockThreshold: number | null;
}


/** Fetch cart with CURRENT DB prices (FR-16, BR-04) — browser prices are ignored.
 *  Exported for server callers (and tests) that already hold a cart id. */
export async function getCartDetailsForCart(
  cartId: string
): Promise<CartDetails> {
  return withPerformanceTiming("cart.details", async () => {
    // One parameterized SQL query retrieves cart items,
    // products, stock and the first product image. Variant lines resolve
    // against the VARIANT's inventory row (and its absolute price
    // override); the null-safe `IS` join matches the product-level row
    // exactly when the line has no variant (Phase 3, Chunk 8 — D12).
    const rows = await db.$queryRaw<CartJoinedRow[]>`
      SELECT
        ci."id" AS "itemId",
        ci."productId",
        ci."variantId",
        ci."quantity",
        ci."giftWrap",
        p."name",
        p."slug",
        p."price",
        p."comparePrice",
        p."status",
        (p."deletedAt" IS NOT NULL) AS "isDeleted",
        v."label" AS "variantLabel",
        v."priceOverride" AS "variantPrice",
        (ci."variantId" IS NOT NULL AND v."id" IS NULL) AS "variantMissing",
        v."isActive" AS "variantActive",
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
      LEFT JOIN "ProductVariant" AS v
        ON v."id" = ci."variantId"
      LEFT JOIN "Inventory" AS i
        ON i."productId" = p."id" AND i."variantId" IS NOT DISTINCT FROM ci."variantId"
      WHERE ci."cartId" = ${cartId}
    `;

    const items: CartItemDetail[] = [];
    let subtotal = 0;
    let itemCount = 0;
    let wrappedUnits = 0;
    // Phase 3, M-13: stale lines are cleaned on load, never silently kept.
    // A line whose product is deleted, no longer published, or out of stock
    // is removed from the stored cart and reported (names included) so the
    // UI can tell the customer what disappeared and why. Lines with
    // reduced-but-nonzero stock stay, clamped to what is available.
    // Variant lines are stale when the variant is gone or deactivated, too
    // (Chunk 8 — D12); the variant label rides on the reported name so the
    // customer can tell which option vanished.
    const isFalsy = (v: boolean | number | null | undefined) => v === false || v === 0;
    const stale = rows.filter(
      (row) =>
        row.status !== "PUBLISHED" ||
        row.isDeleted ||
        row.variantMissing ||
        (row.variantId !== null && isFalsy(row.variantActive)) ||
        (row.stock ?? 0) <= 0
    );
    const removed = stale.map((row) => ({
      productId: row.productId,
      name: row.variantLabel ? `${row.name} (${row.variantLabel})` : row.name,
    }));
    if (stale.length > 0) {
      await db.cartItem.deleteMany({
        where: { id: { in: stale.map((row) => row.itemId) } },
      });
    }
    const staleIds = new Set(stale.map((row) => row.itemId));

    for (const row of rows) {
      if (staleIds.has(row.itemId)) continue;

      const stock = row.stock ?? 0;

      // Clamp the effective quantity to available stock. The returned
      // quantity IS the effective quantity: display, line totals and the
      // subtotal all use it, so the cart subtotal equals the checkout
      // quote subtotal. The stored CartItem quantity may be higher (stock
      // dropped after the item was added); placeOrder re-reads the stored
      // quantity inside its transaction and rejects that overstock by name
      // instead of silently fulfilling a smaller quantity.
      const effectiveQuantity = Math.min(
        row.quantity,
        Math.max(0, stock)
      );

      // Always calculate totals from current DB prices. A variant's
      // ABSOLUTE price override replaces the product price for the line
      // (Chunk 8 — D12); the quote and placeOrder paths resolve the same
      // effective price from the same rows, so the three can never disagree.
      const unitPrice = row.variantPrice ?? row.price;
      const lineTotal = unitPrice * effectiveQuantity;

      items.push({
        itemId: row.itemId,
        productId: row.productId,
        variantId: row.variantId,
        variantLabel: row.variantLabel,
        name: row.name,
        slug: row.slug,
        price: unitPrice,
        comparePrice: row.comparePrice,
        image: row.image,
        quantity: effectiveQuantity,
        stock,
        lowStock:
          stock > 0 &&
          stock <= (row.lowStockThreshold ?? 5),
        outOfStock: stock <= 0,
        lineTotal,
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
      removed,
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
    // Same guard as resolveCartImpl (PR-25): an invalidated session must
    // not reach the user's cart, including its item count.
    const user = await withPerformanceMeasurement(
      "cart.count.session",
      getSessionUser,
      requestId
    );
    const cartOwner = await withPerformanceMeasurement(
      "cart.count.owner",
      async () => {
        const guestCartKey = user?.id
          ? undefined
          : (await cookies()).get(GUEST_CART_COOKIE)?.value;
        return user?.id
          ? { kind: "user" as const, id: user.id }
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
          LEFT JOIN "Inventory" AS i ON i."productId" = p."id" AND i."variantId" IS NOT DISTINCT FROM item."variantId"
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
    LEFT JOIN "Inventory" AS i ON i."productId" = p."id" AND i."variantId" IS NOT DISTINCT FROM item."variantId"
    WHERE item."cartId" = ${cartId}
  `;

  return rows.reduce((count, row) => {
    if (row.status !== "PUBLISHED" || row.isDeleted) return count;
    const stock = row.stock ?? 0;
    return count + Math.min(row.quantity, Math.max(0, stock));
  }, 0);
}

export async function addToCart(productId: string, quantity: number, variantId?: string | null) {
  return withPerformanceTiming("cart.add", async () => {
    const cart = await resolveCart(true);
    if (!cart) throw new Error("Could not create cart");

    // Phase 3, M-12: the stock re-check and the write run inside one
    // transaction, so two concurrent adds cannot both pass the check
    // against the same stock and oversell. (Cart resolution stays outside:
    // it may create the cart and set the guest cookie.)
    await db.$transaction(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, status: "PUBLISHED", deletedAt: null },
        select: { inventory: { select: { variantId: true, quantity: true } } },
      });
      if (!product) throw new Error("This product is not available");
      // A variant line is validated against the VARIANT (Chunk 8 — D12):
      // it must exist, belong to this product and be active, and its own
      // stock row is what the quantity is checked against.
      if (variantId) {
        await getVariantForLine(tx, productId, variantId);
      }
      const stock = inventoryForVariant(product.inventory, variantId ?? null)?.quantity ?? 0;
      if (stock <= 0) throw new Error("Sorry, this product is out of stock");

      const existing = await tx.cartItem.findFirst({
        where: { cartId: cart.id, productId, variantId: variantId ?? null },
        select: { id: true, quantity: true },
      });
      // Never silently clamp to stock (Phase 3, H-8): asking for more than is
      // available throws, consistent with applyCartItemUpdate — the caller must
      // show the error instead of a false "Added to cart" for a partial
      // fulfilment the customer did not ask for.
      const requested = Math.max(1, quantity);
      const desired = (existing?.quantity ?? 0) + requested;
      if (desired > stock) throw new Error(`Only ${stock} unit(s) available in stock`);
      if (existing) {
        await tx.cartItem.update({ where: { id: existing.id }, data: { quantity: desired } });
      } else {
        await tx.cartItem.create({
          data: { cartId: cart.id, productId, variantId: variantId ?? null, quantity: requested },
        });
      }
    });

    return {
      itemCount: await withPerformanceTiming("cart.count", () => getCartItemCount(cart.id)),
    };
  });
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
 *  fields were sent together). Quantity semantics: <= 0 deletes the line;
 *  above stock throws. */
export async function applyCartItemUpdate(
  itemId: string,
  patch: { quantity?: number; giftWrap?: boolean }
) {
  const cart = await resolveCart(false);
  if (!cart) throw new Error("Cart not found");
  // Phase 3, M-12: transactional read-check-write.
  await db.$transaction(async (tx) => {
    const item = await tx.cartItem.findFirst({
      where: { id: itemId, cartId: cart.id },
      include: {
        product: { include: { inventory: true } },
        variant: { include: { inventory: true } },
      },
    });
    if (!item) throw new Error("Cart item not found");
    // A variant line checks against the VARIANT's stock row (Chunk 8 —
    // D12); a deactivated variant can no longer be updated at all.
    if (item.variantId && (!item.variant || !item.variant.isActive)) {
      throw new Error("This variant is no longer available");
    }
    const stock = item.variant
      ? item.variant.inventory?.quantity ?? 0
      : inventoryForVariant(item.product.inventory, null)?.quantity ?? 0;
    if (patch.quantity !== undefined && patch.quantity <= 0) {
      await tx.cartItem.delete({ where: { id: item.id } });
      return;
    }
    if (patch.quantity !== undefined) {
      if (patch.quantity > stock) throw new Error(`Only ${stock} unit(s) available in stock`);
    }
    if (patch.giftWrap !== undefined || patch.quantity !== undefined) {
      await tx.cartItem.update({
        where: { id: item.id },
        data: {
          ...(patch.giftWrap !== undefined ? { giftWrap: patch.giftWrap } : {}),
          ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
        },
      });
    }
  });
  return getCartDetailsForCart(cart.id);
}

/** Empty the cart (after successful order placement). */
export async function clearCart(cartId: string) {
  await db.cartItem.deleteMany({ where: { cartId } });
}

// Guest carts have no owner to come back for them, and nothing ever
// expired them (Phase 3, chunk 12 follow-up B): abandoned guest carts
// accumulated forever. 30 days matches the guest-cart cookie lifetime —
// a cart older than its cookie is unreachable by definition, so pruning
// it deletes nothing a customer could still reach. Only guest carts
// (userId null) are pruned; a signed-in customer's cart is theirs to
// keep. CartItem rows cascade from the cart delete.
export const GUEST_CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function pruneStaleGuestCarts(now = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - GUEST_CART_TTL_MS);
  const deleted = await db.cart.deleteMany({
    where: { userId: null, updatedAt: { lt: cutoff } },
  });
  return { deleted: deleted.count };
}

const EMPTY_MERGE_SUMMARY: GuestCartMergeSummary = {
  merged: [],
  skipped: [],
  cookieCleared: false,
};

/**
 * Best-effort guest-cart cookie clear. Returns false when the cookie store
 * cannot be mutated — Next.js seals cookies() during page render (the
 * checkout page is a Server Component), and test doubles may not implement
 * delete at all. The caller must not treat false as a merge failure: the
 * guest cart row is deleted regardless, so a stale cookie points at a
 * deleted cart and the next guest-cart creation reuses the same key.
 */
function clearGuestCartCookie(
  store: { delete?: (name: string) => unknown }
): boolean {
  try {
    if (typeof store.delete !== "function") return false;
    store.delete(GUEST_CART_COOKIE);
    return true;
  } catch {
    return false;
  }
}

/** Merge a guest cart into the user cart after sign-in (FR-17 continuity).
 *
 *  Every guest line is validated before it is copied (Phase 3, H-7):
 *  deleted, non-published and out-of-stock products are skipped, and the
 *  merged quantity is clamped to available stock and to the API cap of 20.
 *  The returned summary lets the caller tell the customer what was merged
 *  and what was skipped and why. The guest cart row is deleted and the
 *  cookie is cleared best-effort (see clearGuestCartCookie).
 *
 *  Performance notes: the guest-cart read happens OUTSIDE the transaction so
 *  the common repeat case (cookie left over after an earlier merge — nothing
 *  to merge) returns without opening a transaction at all. When there IS
 *  something to merge, existing user-cart lines are prefetched once and merge
 *  decisions run in memory instead of one findUnique per guest line.
 */
export async function mergeGuestCart(userId: string): Promise<GuestCartMergeSummary> {
  const store = await cookies();
  const key = store.get(GUEST_CART_COOKIE)?.value;
  if (!key) return { ...EMPTY_MERGE_SUMMARY };

  const guestCart = await db.cart.findUnique({
    where: { sessionKey: key },
    include: { items: true },
  });
  if (!guestCart || guestCart.items.length === 0) {
    // Stale cookie pointing at a deleted or empty cart — nothing to merge,
    // but clear the cookie while we are here so the repeat case stops.
    return { ...EMPTY_MERGE_SUMMARY, cookieCleared: clearGuestCartCookie(store) };
  }

  // Collapse duplicate guest lines for the same (product, variant) in
  // memory so the unique(cartId, productId, variantId) constraint can
  // never be violated by createMany. A guest line with a variant and a
  // guest line without one for the SAME product are different lines
  // (Chunk 8 — D12) and must never be collapsed into each other.
  const guestLines = new Map<
    string,
    { productId: string; variantId: string | null; quantity: number; giftWrap: boolean }
  >();
  for (const item of guestCart.items) {
    const key = `${item.productId}:${item.variantId ?? ""}`;
    const prev = guestLines.get(key);
    guestLines.set(
      key,
      prev
        ? {
            productId: item.productId,
            variantId: item.variantId,
            quantity: prev.quantity + item.quantity,
            giftWrap: prev.giftWrap || item.giftWrap,
          }
        : {
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            giftWrap: item.giftWrap,
          }
    );
  }

  const summary = await db.$transaction(async (tx) => {
    const merged: GuestCartMergeSummary["merged"] = [];
    const skipped: GuestCartMergeSummary["skipped"] = [];

    // Validate every guest line against live product state before copying.
    const products = await tx.product.findMany({
      where: { id: { in: [...guestLines.values()].map((l) => l.productId) } },
      select: {
        id: true,
        name: true,
        status: true,
        deletedAt: true,
        inventory: { select: { variantId: true, quantity: true } },
      },
    });
    const byProductId = new Map(products.map((p) => [p.id, p]));
    // Variant rows for the guest lines that carry one (Chunk 8 — D12).
    const variantIds = [...guestLines.values()]
      .map((l) => l.variantId)
      .filter((v): v is string => v !== null);
    const variants = variantIds.length > 0
      ? await tx.productVariant.findMany({
          where: { id: { in: variantIds } },
          include: { inventory: true },
        })
      : [];
    const byVariantId = new Map(variants.map((v) => [v.id, v]));

    const userCart = await tx.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
    const existingItems = await tx.cartItem.findMany({
      where: { cartId: userCart.id },
      select: { id: true, productId: true, variantId: true, quantity: true, giftWrap: true },
    });
    const existingByKey = new Map(existingItems.map((i) => [`${i.productId}:${i.variantId ?? ""}`, i]));

    const toCreate: {
      cartId: string;
      productId: string;
      variantId: string | null;
      quantity: number;
      giftWrap: boolean;
    }[] = [];
    for (const item of guestLines.values()) {
      const product = byProductId.get(item.productId);
      if (!product || product.status !== "PUBLISHED" || product.deletedAt !== null) {
        skipped.push({
          productId: item.productId,
          name: product?.name ?? "Unavailable product",
          reason: "unavailable",
        });
        continue;
      }
      // A variant line is validated against the VARIANT: it must exist,
      // belong to this product and be active, and its own stock row is
      // what the quantity is clamped to. A line whose variant is gone is
      // skipped with a reason, never silently converted to a no-variant
      // line (that would buy different stock at a different price).
      let displayName = product.name;
      let stock = inventoryForVariant(product.inventory, null)?.quantity ?? 0;
      if (item.variantId) {
        const variant = byVariantId.get(item.variantId);
        if (!variant || variant.productId !== item.productId || !variant.isActive) {
          skipped.push({
            productId: item.productId,
            name: variant ? `${product.name} (${variant.label})` : product.name,
            reason: "unavailable",
          });
          continue;
        }
        displayName = `${product.name} (${variant.label})`;
        stock = variant.inventory?.quantity ?? 0;
      }
      if (stock <= 0) {
        skipped.push({ productId: item.productId, name: displayName, reason: "out_of_stock" });
        continue;
      }
      const cap = Math.min(stock, CART_API_MAX_QUANTITY);
      const existing = existingByKey.get(`${item.productId}:${item.variantId ?? ""}`);
      const target = Math.min((existing?.quantity ?? 0) + item.quantity, cap);
      const added = target - (existing?.quantity ?? 0);
      if (added <= 0) {
        skipped.push({ productId: item.productId, name: displayName, reason: "already_in_cart" });
        continue;
      }
      merged.push({ productId: item.productId, name: displayName, quantity: added });
      if (existing) {
        await tx.cartItem.update({
          where: { id: existing.id },
          data: {
            quantity: target,
            giftWrap: existing.giftWrap || item.giftWrap,
          },
        });
      } else {
        toCreate.push({
          cartId: userCart.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: target,
          giftWrap: item.giftWrap,
        });
      }
    }
    if (toCreate.length > 0) {
      await tx.cartItem.createMany({ data: toCreate });
    }
    await tx.cart.delete({ where: { id: guestCart.id } });
    return { merged, skipped };
  });

  return { ...summary, cookieCleared: clearGuestCartCookie(store) };
}
