// Admin: promotion create (FR-42).
import { db } from "@/lib/db";
import { promotionSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-promotions-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
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
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.PROMOTION_CREATED,
      targetType: "Promotion",
      targetId: promotion.id,
      metadata: { title: d.title },
    });
    return jsonOk({ promotion });
  });
}
