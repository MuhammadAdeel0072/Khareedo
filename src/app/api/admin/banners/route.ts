// Admin: banner create (FR-42).
import { adminCreateBanner } from "@/services/banners.service";
import { bannerSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";

export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const parsed = await parseBody(request, bannerSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const banner = await adminCreateBanner({
      title: d.title,
      subtitle: d.subtitle || undefined,
      imageUrl: d.imageUrl,
      linkUrl: d.linkUrl || undefined,
      placement: d.placement,
      isActive: d.isActive,
      sortOrder: d.sortOrder,
    });
    return jsonOk({ banner });
  });
}
