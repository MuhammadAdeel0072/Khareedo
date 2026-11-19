// Admin: banner update / delete (FR-42).
import { adminUpdateBanner, adminDeleteBanner } from "@/services/banners.service";
import { bannerSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
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
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.BANNER_UPDATED,
      targetType: "Banner",
      targetId: id,
      metadata: { title: d.title },
    });
    return jsonOk({ banner });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const { id } = await ctx.params;
    await adminDeleteBanner(id);
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.BANNER_DELETED,
      targetType: "Banner",
      targetId: id,
    });
    return jsonOk({});
  });
}
