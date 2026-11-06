// Banner service — homepage promotional content (FR-12, FR-42, FR-51).
import { db } from "@/lib/db";
import { revalidateTag, unstable_cache } from "next/cache";

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

export async function adminUpdateBanner(id: string, input: BannerWriteInput) {
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
  return banner;
}

export async function adminDeleteBanner(id: string) {
  await db.banner.delete({ where: { id } });
  revalidateTag(BANNERS_CACHE_TAG, { expire: 0 });
}
