// Admin banners page (FR-42).
import { adminListBanners } from "@/services/banners.service";
import { BannersManager } from "@/components/admin/banners-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Banners · Admin" };

export default async function AdminBannersPage() {
  const banners = await adminListBanners();
  return (
    <div className="p-4 sm:p-6">
      <BannersManager
        initial={banners.map((b) => ({
          id: b.id,
          title: b.title,
          subtitle: b.subtitle,
          imageUrl: b.imageUrl,
          linkUrl: b.linkUrl,
          placement: b.placement as "HERO" | "SIDE" | "STRIP",
          isActive: b.isActive,
          sortOrder: b.sortOrder,
        }))}
      />
    </div>
  );
}
