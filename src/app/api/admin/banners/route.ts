// Admin: banner create (FR-42).
import { adminCreateBanner } from "@/services/banners.service";
import { bannerSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
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
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.BANNER_CREATED,
      targetType: "Banner",
      targetId: banner.id,
      metadata: { title: d.title },
    });
    return jsonOk({ banner });
  });
}
