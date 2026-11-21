// Customer order cancellation (Phase 3, Chunk 2-final — H-11/D1).
// Customers may cancel their own orders in PENDING, CONFIRMED or PROCESSING
// only; the service enforces ownership, the status rule, and the atomic
// inventory/coupon restoration.
import { customerCancelOrder } from "@/services/orders.service";
import { requireUser } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, handleRoute, readBoundedBodyText } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  return withPerformanceTiming("api.account.order.cancel", () =>
    handleRoute(async () => {
      const user = await requireUser();
      // A cancel is a state-changing write: per-user rate limit, same
      // pattern as the address write routes.
      const limit = rateLimit(`order-cancel:${user.id}`, 10, 60 * 1000);
      if (!limit.ok) {
        return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
          headers: { "Retry-After": String(limit.retryAfterSec) },
        });
      }
      const { id } = await ctx.params;
      // Stage 3 audit, L-5: the body is read under parseBody's 1 MiB cap
      // (the old request.json() had no cap). An oversized body is 413; an
      // unparseable body still yields null here, so the reason checks
      // below behave exactly as before (reason defaults to null).
      const read = await readBoundedBodyText(request);
      if (!read.ok && read.reason === "too-large") {
        return jsonError("Request body is too large.", 413);
      }
      let body: unknown = null;
      if (read.ok) {
        try { body = JSON.parse(read.text); } catch { body = null; }
      }
      const reason = (body as { reason?: unknown } | null)?.reason;
      if (reason !== undefined && reason !== null && typeof reason !== "string") {
        return jsonError("Invalid cancellation reason.", 422);
      }
      const result = await customerCancelOrder(id, user.id, typeof reason === "string" ? reason : null);
      if (!result.ok) {
        const status = result.code === "NOT_FOUND" ? 404 : result.code === "INVALID_STATUS" ? 409 : 422;
        return jsonError(result.error ?? "Unable to cancel this order.", status, { code: result.code });
      }
      return jsonOk({ order: result.order, alreadyCancelled: result.alreadyCancelled ?? false });
    })
  );
}
