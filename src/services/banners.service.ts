// Banner service — homepage promotional content (FR-12, FR-42, FR-51).
import { db } from "@/lib/db";

export async function getActiveBanners(placement: "HERO" | "SIDE" | "STRIP", limit = 5) {
  return db.banner.findMany({
    where: { placement, isActive: true },
    orderBy: { sortOrder: "asc" },
    take: limit,
  });
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
  return db.banner.create({
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
}

export async function adminUpdateBanner(id: string, input: BannerWriteInput) {
  return db.banner.update({
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
}

export async function adminDeleteBanner(id: string) {
  await db.banner.delete({ where: { id } });
}
