// Customer review edit (Phase 3, Chunk 9 — D13). The author may edit
// their own review; the edit returns it to pending moderation. There is
// no customer delete in V1 — only edit (an admin rejects instead).
import { updateReview } from "@/services/reviews.service";
import { reviewSchema } from "@/lib/validation";
import { requireUser } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return withPerformanceTiming("api.account.reviews.update", () =>
    handleRoute(async () => {
      const user = await requireUser();
      const limit = rateLimit(`account-review-update:${user.id}`, 60, 60_000);
      if (!limit.ok) {
        return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
          headers: { "Retry-After": String(limit.retryAfterSec) },
        });
      }
      const { id } = await ctx.params;
      const parsed = await parseBody(request, reviewSchema);
      if (parsed.error) return parsed.error;
      const result = await updateReview({
        reviewId: id,
        userId: user.id,
        rating: parsed.data.rating,
        text: parsed.data.text ?? null,
      });
      if (!result.ok) {
        const status = result.code === "NOT_FOUND" ? 404 : 422;
        return jsonError(result.error ?? "Unable to update your review.", status, { code: result.code });
      }
      return jsonOk({ review: result.review });
    })
  );
}
