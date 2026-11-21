// Profile update (FR-05).
import { updateProfile } from "@/services/users.service";
import { profileSchema } from "@/lib/validation";
import { requireUser } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, handleRoute, parseBody } from "@/lib/api";

export async function PUT(request: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const limit = rateLimit(`account-profile:${user.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    // Stage 3 audit, L-5: parseBody caps the body at 1 MiB (the old
    // request.json() had no cap) and validates against the same schema
    // updateProfile uses, so invalid input still maps to 422 with field
    // errors and an unparseable body still maps to 400.
    const parsed = await parseBody(request, profileSchema);
    if (parsed.error) return parsed.error;
    const result = await updateProfile(user.id, parsed.data);
    if (!result.ok) return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });
    return jsonOk({});
  });
}
