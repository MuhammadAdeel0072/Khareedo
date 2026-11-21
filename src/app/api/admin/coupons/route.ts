// Admin: coupon create (D-06 confirmed rules).
import { db } from "@/lib/db";
import { couponSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

function toDates(d: { startsAt?: string; expiresAt?: string }) {
  return {
    startsAt: d.startsAt ? new Date(d.startsAt) : null,
    expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
  };
}

export async function POST(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-coupons-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const parsed = await parseBody(request, couponSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const clash = await db.coupon.findUnique({ where: { code: d.code } });
    if (clash) return jsonError("A coupon with this code already exists.", 409, { errors: { code: "Already exists" } });
    const coupon = await db.coupon.create({
      data: {
        code: d.code,
        description: d.description || null,
        type: d.type,
        value: d.value,
        minOrderAmount: d.minOrderAmount,
        maxUses: d.maxUses ?? null,
        maxDiscountAmount: d.maxDiscountAmount ?? null,
        firstOrderOnly: d.firstOrderOnly ?? false,
        isActive: d.isActive,
        ...toDates(d),
      },
    });
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.COUPON_CREATED,
      targetType: "Coupon",
      targetId: coupon.id,
      metadata: { code: d.code },
    });
    return jsonOk({ coupon });
  });
}
