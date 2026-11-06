// Admin: coupon update / delete (D-06).
import { db } from "@/lib/db";
import { couponSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import { adminUpdateCoupon, adminDeleteCoupon } from "@/services/promotions.service";
import { ReservationWriteConflict } from "@/services/reservation-writes";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const parsed = await parseBody(request, couponSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const clash = await db.coupon.findFirst({ where: { code: d.code, id: { not: id } } });
    if (clash) return jsonError("A coupon with this code already exists.", 409, { errors: { code: "Already exists" } });
    try {
      return jsonOk({ coupon: await adminUpdateCoupon(id, d) });
    } catch (error) {
      if (error instanceof ReservationWriteConflict) return jsonError(error.message, 409);
      throw error;
    }
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    try { await adminDeleteCoupon(id); } catch (error) {
      if (error instanceof ReservationWriteConflict) return jsonError(error.message, 409);
      throw error;
    }
    return jsonOk({});
  });
}
