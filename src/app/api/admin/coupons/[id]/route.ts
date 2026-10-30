// Admin: coupon update / delete (D-06).
import { db } from "@/lib/db";
import { couponSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";

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
    const coupon = await db.coupon.update({
      where: { id },
      data: {
        code: d.code,
        description: d.description || null,
        type: d.type,
        value: d.value,
        minOrderAmount: d.minOrderAmount,
        maxUses: d.maxUses ?? null,
        isActive: d.isActive,
        startsAt: d.startsAt ? new Date(d.startsAt) : null,
        expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
      },
    });
    return jsonOk({ coupon });
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    await db.coupon.delete({ where: { id } });
    return jsonOk({});
  });
}
