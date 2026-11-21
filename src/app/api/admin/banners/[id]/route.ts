// Admin: banner update / delete (FR-42).
import { adminUpdateBanner, adminDeleteBanner } from "@/services/banners.service";
import { bannerSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute, prismaNotFoundResponse } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-banners-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const { id } = await ctx.params;
    const parsed = await parseBody(request, bannerSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    let banner;
    try {
      banner = await adminUpdateBanner(id, {
        title: d.title,
        subtitle: d.subtitle || undefined,
        imageUrl: d.imageUrl,
        linkUrl: d.linkUrl || undefined,
        placement: d.placement,
        isActive: d.isActive,
        sortOrder: d.sortOrder,
      });
    } catch (error) {
      // Stage 3 audit, M-5: updating a missing banner threw P2025
      // into handleRoute's generic 500. It is a 404.
      const notFound = prismaNotFoundResponse(error, "Banner not found.");
      if (notFound) return notFound;
      throw error;
    }
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
    const limit = rateLimit(`admin-banners-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const { id } = await ctx.params;
    try {
      await adminDeleteBanner(id);
    } catch (error) {
      // Stage 3 audit, M-5: deleting a missing banner threw P2025
      // into handleRoute's generic 500. It is a 404.
      const notFound = prismaNotFoundResponse(error, "Banner not found.");
      if (notFound) return notFound;
      throw error;
    }
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.BANNER_DELETED,
      targetType: "Banner",
      targetId: id,
    });
    return jsonOk({});
  });
}
