// Wishlist service (FR-05, customer-only feature — D-08 scope).
import { db } from "@/lib/db";
import { totalProductStock } from "@/services/variants.service";

export interface WishlistRow {
  itemId: string;
  productId: string;
  name: string;
  slug: string;
  price: number;
  comparePrice: number | null;
  image: string | null;
  rating: number;
  reviewCount: number;
  stock: number;
}

export async function getWishlist(userId: string): Promise<WishlistRow[]> {
  // Availability is pushed into the WHERE (S8): only rows whose product is
  // live (PUBLISHED, not soft-deleted) are fetched, instead of fetching
  // every row with its product + image + inventory and filtering in memory.
  const rows = await db.wishlistItem.findMany({
    where: { userId, product: { status: "PUBLISHED", deletedAt: null } },
    orderBy: { createdAt: "desc" },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          price: true,
          comparePrice: true,
          rating: true,
          reviewCount: true,
          images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } },
          inventory: { select: { variantId: true, quantity: true } },
        },
      },
    },
  });
  return rows.map((r) => ({
    itemId: r.id,
    productId: r.product.id,
    name: r.product.name,
    slug: r.product.slug,
    price: r.product.price,
    comparePrice: r.product.comparePrice,
    image: r.product.images[0]?.url ?? null,
    rating: r.product.rating,
    reviewCount: r.product.reviewCount,
    // Wishlist stays product-level (Chunk 8 — D12): no per-variant
    // wishlist. Stock is the total across the product-level row and all
    // variant rows — the item is "in stock" while any row has stock.
    stock: totalProductStock(r.product.inventory),
  }));
}

export async function toggleWishlist(userId: string, productId: string): Promise<{ added: boolean }> {
  const existing = await db.wishlistItem.findUnique({
    where: { userId_productId: { userId, productId } },
  });
  if (existing) {
    await db.wishlistItem.delete({ where: { id: existing.id } });
    return { added: false };
  }
  await db.wishlistItem.create({ data: { userId, productId } });
  return { added: true };
}

export async function getWishlistProductIds(userId: string): Promise<string[]> {
  const rows = await db.wishlistItem.findMany({
    where: { userId },
    select: { productId: true },
  });
  return rows.map((r) => r.productId);
}

/** Cheap wishlist size for the account overview — a count instead of joining
 *  product + image + inventory for every row just to read `.length`. */
export async function getWishlistCount(userId: string): Promise<number> {
  return db.wishlistItem.count({ where: { userId } });
}
