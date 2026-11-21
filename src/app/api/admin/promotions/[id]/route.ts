// Admin: promotion update / delete (FR-42).
import { db } from "@/lib/db";
import { promotionSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute, prismaNotFoundResponse } from "@/lib/api";
import { adminUpdatePromotion } from "@/services/promotions.service";
import { ReservationWriteConflict } from "@/services/reservation-writes";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-promotions-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const { id } = await ctx.params;
    const parsed = await parseBody(request, promotionSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    try {
      const promotion = await adminUpdatePromotion(id, d);
      await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
        action: ADMIN_AUDIT_ACTIONS.PROMOTION_UPDATED,
        targetType: "Promotion",
        targetId: id,
        metadata: { title: d.title },
      });
      return jsonOk({ promotion });
    } catch (error) {
      // Stale-form edit (optimistic lock): 409, mirroring the coupon route.
      if (error instanceof ReservationWriteConflict) return jsonError(error.message, 409);
      // Stage 3 audit, M-5: P2025 → 404, not handleRoute's generic 500.
      const notFound = prismaNotFoundResponse(error, "Promotion not found.");
      if (notFound) return notFound;
      throw error;
    }
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-promotions-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const { id } = await ctx.params;
    try {
      await db.promotion.delete({ where: { id } });
    } catch (error) {
      // Stage 3 audit, M-5: deleting a missing promotion threw P2025
      // into handleRoute's generic 500. It is a 404.
      const notFound = prismaNotFoundResponse(error, "Promotion not found.");
      if (notFound) return notFound;
      throw error;
    }
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.PROMOTION_DELETED,
      targetType: "Promotion",
      targetId: id,
    });
    return jsonOk({});
  });
}
