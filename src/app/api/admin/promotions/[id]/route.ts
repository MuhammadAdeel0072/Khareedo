// Admin: promotion update / delete (FR-42).
import { db } from "@/lib/db";
import { promotionSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const parsed = await parseBody(request, promotionSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const promotion = await db.promotion.update({
      where: { id },
      data: {
        title: d.title,
        description: d.description || null,
        type: d.type,
        value: d.value,
        minOrderAmount: d.minOrderAmount ?? null,
        isActive: d.isActive,
        startsAt: d.startsAt ? new Date(d.startsAt) : null,
        endsAt: d.endsAt ? new Date(d.endsAt) : null,
      },
    });
    return jsonOk({ promotion });
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    await db.promotion.delete({ where: { id } });
    return jsonOk({});
  });
}
