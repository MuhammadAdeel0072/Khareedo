// Wishlist toggle (FR-05 — registered customers only).
import { z } from "zod";
import { toggleWishlist } from "@/services/wishlist.service";
import { requireUser } from "@/lib/auth-guard";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";

const schema = z.object({ productId: z.string().min(1) });

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireUser();

    // 60/min per client IP (Phase 2, area A). Checked after auth so a
    // flood cannot burn the wishlist service anonymously.
    const ip = clientIp(request.headers);
    const limit = rateLimit(`wishlist:${ip}`, 60, 60 * 1000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }

    const parsed = await parseBody(request, schema);
    if (parsed.error) return parsed.error;
    const result = await toggleWishlist(user.id, parsed.data.productId);
    return jsonOk(result);
  });
}
