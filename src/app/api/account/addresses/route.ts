// Address create (FR-05). Ownership enforced via session userId (NFR-11).
import { createAddress } from "@/services/users.service";
import { addressSchema } from "@/lib/validation";
import { requireUser } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, handleRoute, parseBody } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

export async function POST(request: Request) {
  return withPerformanceTiming("api.address.create", () => handleRoute(async () => {
    const user = await requireUser();
    // Same per-user write cap as the PUT/DELETE routes (Phase 3, chunk
    // 12 follow-up B): 30/min per user.
    const limit = rateLimit(`addresses-write:${user.id}`, 30, 60 * 1000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    // Stage 3 audit, L-5: parseBody caps the body at 1 MiB (the old
    // request.json() had no cap) and validates against the same schema
    // createAddress uses, so invalid input still maps to 422.
    const parsed = await parseBody(request, addressSchema);
    if (parsed.error) return parsed.error;
    const result = await createAddress(user.id, parsed.data);
    if (!result.ok) return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });
    return jsonOk({ address: result.address });
  }));
}
