// Wishlist service (FR-05, customer-only feature — D-08 scope).
import { db } from "@/lib/db";

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
  const rows = await db.wishlistItem.findMany({
    where: { userId },
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
          status: true,
          deletedAt: true,
          images: { take: 1, orderBy: { sortOrder: "asc" }, select: { url: true } },
          inventory: { select: { quantity: true } },
        },
      },
    },
  });
  return rows
    .filter((r) => r.product.status === "PUBLISHED" && !r.product.deletedAt)
    .map((r) => ({
      itemId: r.id,
      productId: r.product.id,
      name: r.product.name,
      slug: r.product.slug,
      price: r.product.price,
      comparePrice: r.product.comparePrice,
      image: r.product.images[0]?.url ?? null,
      rating: r.product.rating,
      reviewCount: r.product.reviewCount,
      stock: r.product.inventory?.quantity ?? 0,
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
