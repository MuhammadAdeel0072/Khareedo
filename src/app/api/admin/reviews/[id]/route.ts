// Admin review moderation action (Phase 3, Chunk 9 — D13). Approve or
// reject one review; the status change and the product rating recompute
// happen in the same transaction inside the service. The moderation is
// audited best-effort (same pattern as product writes) — an audit-write
// failure never blocks the moderation itself.
import { moderateReview } from "@/services/reviews.service";
import { reviewModerationSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";
import { withPerformanceTiming } from "@/lib/performance-timing";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return withPerformanceTiming("api.admin.reviews.moderate", () =>
    handleRoute(async () => {
      const admin = await requireAdminMfaVerified();
      const limit = rateLimit(`admin-reviews-moderate:${admin.id}`, 60, 60_000);
      if (!limit.ok) {
        return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
          headers: { "Retry-After": String(limit.retryAfterSec) },
        });
      }
      const { id } = await ctx.params;
      const parsed = await parseBody(request, reviewModerationSchema);
      if (parsed.error) return parsed.error;
      const result = await moderateReview({ reviewId: id, action: parsed.data.action });
      if (!result.ok) {
        const status = result.code === "NOT_FOUND" ? 404 : 422;
        return jsonError(result.error ?? "Unable to moderate this review.", status, { code: result.code });
      }
      await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
        action:
          parsed.data.action === "APPROVED"
            ? ADMIN_AUDIT_ACTIONS.REVIEW_APPROVED
            : ADMIN_AUDIT_ACTIONS.REVIEW_REJECTED,
        targetType: "Review",
        targetId: id,
        metadata: { productId: result.review?.productId, rating: result.review?.rating },
      });
      return jsonOk({ review: result.review });
    })
  );
}
