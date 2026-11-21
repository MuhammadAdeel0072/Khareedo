// Product reviews — public approved list + customer create (Phase 3,
// Chunk 9 — D13). Approved reviews only, newest first, 10 per page.
// Creation requires login + a DELIVERED order for the product; the
// service returns the same 404 for a non-purchaser as for a missing
// product, so eligibility is never leaked.
import { db } from "@/lib/db";
import { createReview, listApprovedReviews } from "@/services/reviews.service";
import { reviewSchema } from "@/lib/validation";
import { requireUser } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

type Ctx = { params: Promise<{ id: string }> };

/** Spam limits (D13): max 5 review submissions/hour per user + a per-IP
 * cap of 20/hour. Both share the in-memory limiter (see rate-limit.ts);
 * the per-IP bucket is best-effort until TRUSTED_PROXY_IPS is set (Q-01)
 * — with no trusted proxy, forwarded headers are ignored and all IPs
 * share one bucket, which is fail-safe, not evadable. */
const REVIEW_USER_LIMIT = 5;
const REVIEW_IP_LIMIT = 20;
const REVIEW_WINDOW_MS = 60 * 60 * 1000;

export async function GET(request: Request, ctx: Ctx) {
  return withPerformanceTiming("api.products.reviews.list", () =>
    handleRoute(async () => {
      const { id } = await ctx.params;
      const product = await db.product.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!product) return jsonError("Product not found.", 404);
      const page = Math.max(1, Number(new URL(request.url).searchParams.get("page") || "1") || 1);
      const result = await listApprovedReviews(id, page);
      return jsonOk({
        reviews: result.reviews,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
        distribution: result.distribution,
      });
    })
  );
}

export async function POST(request: Request, ctx: Ctx) {
  return withPerformanceTiming("api.products.reviews.create", () =>
    handleRoute(async () => {
      const user = await requireUser();
      const userLimit = rateLimit(`review-create:${user.id}`, REVIEW_USER_LIMIT, REVIEW_WINDOW_MS);
      if (!userLimit.ok) {
        return jsonError(`Too many reviews. Please try again in ${userLimit.retryAfterSec}s.`, 429, undefined, {
          headers: { "Retry-After": String(userLimit.retryAfterSec) },
        });
      }
      const ipLimit = rateLimit(
        `review-create-ip:${clientIp(request.headers)}`,
        REVIEW_IP_LIMIT,
        REVIEW_WINDOW_MS
      );
      if (!ipLimit.ok) {
        return jsonError(`Too many reviews. Please try again in ${ipLimit.retryAfterSec}s.`, 429, undefined, {
          headers: { "Retry-After": String(ipLimit.retryAfterSec) },
        });
      }
      const { id } = await ctx.params;
      const parsed = await parseBody(request, reviewSchema);
      if (parsed.error) return parsed.error;
      const result = await createReview({
        productId: id,
        userId: user.id,
        rating: parsed.data.rating,
        text: parsed.data.text ?? null,
      });
      if (!result.ok) {
        const status = result.code === "NOT_FOUND" ? 404 : result.code === "ALREADY_EXISTS" ? 409 : 422;
        return jsonError(result.error ?? "Unable to submit your review.", status, { code: result.code });
      }
      return jsonOk({ review: result.review });
    })
  );
}
