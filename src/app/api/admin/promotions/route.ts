// Admin: promotion create (FR-42).
import { db } from "@/lib/db";
import { promotionSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";

export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const parsed = await parseBody(request, promotionSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const promotion = await db.promotion.create({
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
