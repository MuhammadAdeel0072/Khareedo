// Admin: coupon update / delete (D-06).
import { db } from "@/lib/db";
import { couponSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import { adminUpdateCoupon, adminDeleteCoupon } from "@/services/promotions.service";
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
    const { id } = await ctx.params;
    const parsed = await parseBody(request, couponSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const clash = await db.coupon.findFirst({ where: { code: d.code, id: { not: id } } });
    if (clash) return jsonError("A coupon with this code already exists.", 409, { errors: { code: "Already exists" } });
    try {
      const coupon = await adminUpdateCoupon(id, d);
      await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
        action: ADMIN_AUDIT_ACTIONS.COUPON_UPDATED,
        targetType: "Coupon",
        targetId: id,
        metadata: { code: d.code },
      });
      return jsonOk({ coupon });
    } catch (error) {
      if (error instanceof ReservationWriteConflict) return jsonError(error.message, 409);
      throw error;
    }
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const { id } = await ctx.params;
    try {
      await adminDeleteCoupon(id);
    } catch (error) {
      if (error instanceof ReservationWriteConflict) return jsonError(error.message, 409);
      throw error;
    }
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.COUPON_DELETED,
      targetType: "Coupon",
      targetId: id,
    });
    return jsonOk({});
  });
}
