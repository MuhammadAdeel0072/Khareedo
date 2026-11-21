// Admin review moderation queue (Phase 3, Chunk 9 — D13). Lists every
// review, newest first, with an optional status filter. Role + MFA are
// enforced here (requireAdminMfaVerified) as on every admin route; the
// admin panel layout enforces them again for the page itself.
import { listReviewsForAdmin } from "@/services/reviews.service";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { jsonOk, handleRoute } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

export async function GET(request: Request) {
  return withPerformanceTiming("api.admin.reviews.list", () =>
    handleRoute(async () => {
      await requireAdminMfaVerified();
      const sp = new URL(request.url).searchParams;
      const status = sp.get("status") ?? undefined;
      const page = Math.max(1, Number(sp.get("page") || "1") || 1);
      const result = await listReviewsForAdmin({ status, page, perPage: 25 });
      return jsonOk({
        reviews: result.reviews,
        total: result.total,
        page: result.page,
        perPage: result.perPage,
        totalPages: Math.max(1, Math.ceil(result.total / result.perPage)),
      });
    })
  );
}
