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
      return jsonError(`Too many attempts. Please try again in ${limit.retryAfterSec}s.`, 429);
    }

    const parsed = await parseBody(request, placeOrderSchema);
    if (parsed.error) return parsed.error;

    const result = await placeOrder(parsed.data, user.id);

    if (!result.ok) {
      return jsonError(result.error, result.code === "DUPLICATE" ? 409 : 422, {
        code: result.code,
      });
    }
    return jsonOk({ reference: result.reference, orderId: result.orderId });
  }));
}
