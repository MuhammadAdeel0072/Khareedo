// Admin: banner update / delete (FR-42).
import { adminUpdateBanner, adminDeleteBanner } from "@/services/banners.service";
import { bannerSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const parsed = await parseBody(request, bannerSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const banner = await adminUpdateBanner(id, {
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

export async function DELETE(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    await adminDeleteBanner(id);
    return jsonOk({});
  });
}
