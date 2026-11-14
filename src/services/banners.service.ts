// Banner service — homepage promotional content (FR-12, FR-42, FR-51).
// Admin writes revalidate the storefront cache immediately, so banner changes
// go live without redeploy. Storage cleanup is orphan-safe: an uploaded image
// object is only deleted when NO banner references it anymore, and cleanup
// failures never block the database operation (worst case: a harmless orphan).
import { db } from "@/lib/db";
import { revalidateTag, unstable_cache } from "next/cache";
import { parseBannerStorageObjectPath, getStorageClient, MEDIA_BUCKET } from "@/lib/storage";

const BANNERS_CACHE_TAG = "storefront-banners";

// Only public editorial content is shared across requests. Function arguments
// keep placement and limit separate; successful admin writes expire every variant.
const readActiveBanners = unstable_cache(
  async (placement: "HERO" | "SIDE" | "STRIP", limit: number) =>
    db.banner.findMany({
      where: { placement, isActive: true },
      orderBy: { sortOrder: "asc" },
      take: limit,
    }),
  ["storefront-banners"],
  { revalidate: 60, tags: [BANNERS_CACHE_TAG] }
);

export async function getActiveBanners(placement: "HERO" | "SIDE" | "STRIP", limit = 5) {
  const banners = await readActiveBanners(placement, limit);
  // unstable_cache uses JSON storage. Retain the existing Prisma Date contract
  // on cache hits as well as misses.
  return banners.map((banner) => ({
    ...banner,
    createdAt: new Date(banner.createdAt),
    updatedAt: new Date(banner.updatedAt),
  }));
}

export async function adminListBanners() {
  return db.banner.findMany({ orderBy: [{ placement: "asc" }, { sortOrder: "asc" }] });
}

export interface BannerWriteInput {
  title: string;
  subtitle?: string;
  imageUrl: string;
  linkUrl?: string;
  placement: "HERO" | "SIDE" | "STRIP";
  isActive: boolean;
  sortOrder: number;
}

export async function adminCreateBanner(input: BannerWriteInput) {
  const banner = await db.banner.create({
    data: {
      title: input.title,
      subtitle: input.subtitle || null,
      imageUrl: input.imageUrl,
      linkUrl: input.linkUrl || null,
      placement: input.placement,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    },
  });
  revalidateTag(BANNERS_CACHE_TAG, { expire: 0 });
  return banner;
}

/**
 * Deletes the storage object behind a banner image URL — but ONLY when it is
 * one of our own banner-prefixed storage objects AND no other banner still
 * references the same URL. Never throws: a failed cleanup must not break the
 * admin operation, it just leaves a harmless unreferenced object behind.
 */
async function cleanupOrphanedImage(imageUrl: string | null | undefined): Promise<void> {
  try {
    const objectKey = parseBannerStorageObjectPath(imageUrl);
    if (!objectKey) return; // external hotlink, product image, or legacy path — never touched

    const referenced = await db.banner.count({ where: { imageUrl: imageUrl! } });
    if (referenced > 0) return; // still in use — shared images are protected

    const supabase = getStorageClient();
    if (!supabase) return; // storage not configured in this environment — skip quietly

    const { error } = await supabase.storage.from(MEDIA_BUCKET).remove([objectKey]);
    if (error) {
      console.warn("[banners] orphaned image cleanup failed:", error.message);
    }
  } catch (error) {
    console.warn("[banners] orphaned image cleanup skipped:", error instanceof Error ? error.message : "unknown");
  }
}

export async function adminUpdateBanner(id: string, input: BannerWriteInput) {
  const previous = await db.banner.findUnique({ where: { id }, select: { imageUrl: true } });
  const banner = await db.banner.update({
    where: { id },
    data: {
      title: input.title,
      subtitle: input.subtitle || null,
      imageUrl: input.imageUrl,
      linkUrl: input.linkUrl || null,
      placement: input.placement,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    },
  });
  revalidateTag(BANNERS_CACHE_TAG, { expire: 0 });

  // Replaced image: clean up the old object if no other banner uses it.
  if (previous && previous.imageUrl && previous.imageUrl !== banner.imageUrl) {
    await cleanupOrphanedImage(previous.imageUrl);
  }
  return banner;
}

export async function adminDeleteBanner(id: string) {
  const previous = await db.banner.findUnique({ where: { id }, select: { imageUrl: true } });
  await db.banner.delete({ where: { id } });
  revalidateTag(BANNERS_CACHE_TAG, { expire: 0 });

  if (previous) {
    await cleanupOrphanedImage(previous.imageUrl);
  }
}
