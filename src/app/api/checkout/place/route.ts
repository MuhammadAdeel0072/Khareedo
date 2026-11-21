// Place an order — server-validated, transactional, idempotent (FR-19..27).
import { placeOrder } from "@/services/checkout.service";
import { placeOrderSchema } from "@/lib/validation";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/auth-guard";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

export async function POST(request: Request) {
  return withPerformanceTiming("api.checkout.place", () => handleRoute(async () => {
    const user = await getSessionUser();
    if (!user) return jsonError("Please sign in to place an order.", 401, { code: "AUTHENTICATION_REQUIRED" });

    const ip = clientIp(request.headers);
    const limit = rateLimit(`checkout:${ip}`, 10, 5 * 60 * 1000);
    if (!limit.ok) {
      // Retry-After, mirroring the quote route (Phase 3, chunk 12
      // follow-up B): the 429 used to carry no header, so a client had
      // no honest backoff signal.
      return jsonError(`Too many attempts. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }

    const parsed = await parseBody(request, placeOrderSchema);
    if (parsed.error) return parsed.error;

    const result = await placeOrder(parsed.data, user.id);

    if (!result.ok) {
      // Contention is 503, not 422 (Phase 3, chunk 12 follow-up B): the
      // request was valid, the store was busy. Retry-After 5s is a
      // conservative first retry for a burst-contention window.
      if (result.code === "BUSY") {
        return jsonError(result.error, 503, { code: result.code }, {
          headers: { "Retry-After": "5" },
        });
      }
      // Stage 3 audit, M-2: the generic ERROR code is the service's
      // catch-all for DB/infrastructure failures (P1001 outage, P2003,
      // anything the BUSY classifier does not recognise) and for
      // CartChangedError ("cart changed, try again"). None of those is a
      // client error, so 422 told a retrying client the request itself
      // was wrong. They are retryable server failures: 503 with
      // Retry-After, same as BUSY. Business failures (OUT_OF_STOCK,
      // EMPTY_CART, COUPON_UNAVAILABLE, MINIMUM_NOT_MET) still map to
      // 422 below; DUPLICATE stays 409.
      if (result.code === "ERROR") {
        return jsonError(result.error, 503, { code: result.code }, {
          headers: { "Retry-After": "5" },
        });
      }
      return jsonError(result.error, result.code === "DUPLICATE" ? 409 : 422, {
        code: result.code,
      });
    }
    return jsonOk({ reference: result.reference, orderId: result.orderId });
  }));
}
