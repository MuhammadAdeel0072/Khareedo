// Server-side checkout quote — the authoritative price preview (BR-06, BR-07, NFR-30).
import { z } from "zod";
import { quoteOrder } from "@/services/checkout.service";
import { getSessionUser } from "@/lib/auth-guard";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { jsonError, parseBody, jsonOk, handleRoute } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

const quoteSchema = z.object({
  deliveryMethod: z.enum(["STANDARD", "EXPRESS"]).default("STANDARD"),
  couponCode: z.string().trim().max(40).optional().or(z.literal("")),
});

export async function POST(request: Request) {
  return withPerformanceTiming("api.checkout.quote", () => handleRoute(async () => {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return jsonError("Please sign in to continue to checkout.", 401, { code: "AUTHENTICATION_REQUIRED" });
    }

    // A quote is a cheap read, but an unauthenticated flood of them is a
    // free CPU/DB burn. 60/min per client IP (Phase 2, area A).
    const ip = clientIp(request.headers);
    const limit = rateLimit(`checkout-quote:${ip}`, 60, 60 * 1000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }

    const parsed = await parseBody(request, quoteSchema);
    if (parsed.error) return parsed.error;
    // The user id lets the quote apply the per-user coupon rules (D11/M-20)
    // as a preview; the place-order transaction re-checks them.
    const quote = await quoteOrder(parsed.data, sessionUser.id);
    return jsonOk({ quote });
  }));
}
