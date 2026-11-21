// Address update/delete with ownership check (FR-05, NFR-11).
import { updateAddress, deleteAddress } from "@/services/users.service";
import { addressSchema } from "@/lib/validation";
import { requireUser } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, handleRoute, parseBody } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

// Address writes are per-user and low-frequency, but unbounded without a
// cap: a flood of PUT/DELETE calls is a free DB burn. 30/min per user
// (Phase 3, chunk 12 follow-up B), mirroring the per-user keys used for
// comparable write routes (e.g. payments-refunds-initiate).
function addressWriteLimit(userId: string) {
  const limit = rateLimit(`addresses-write:${userId}`, 30, 60 * 1000);
  if (!limit.ok) {
    return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
      headers: { "Retry-After": String(limit.retryAfterSec) },
    });
  }
  return null;
}

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const user = await requireUser();
    const limited = addressWriteLimit(user.id);
    if (limited) return limited;
    const { id } = await ctx.params;
    // Stage 3 audit, L-5: parseBody caps the body at 1 MiB (the old
    // request.json() had no cap) and validates against the same schema
    // updateAddress uses, so invalid input still maps to 422.
    const parsed = await parseBody(request, addressSchema);
    if (parsed.error) return parsed.error;
    const result = await updateAddress(user.id, id, parsed.data);
    if (!result.ok) {
      // Missing addresses are 404, like DELETE (Phase 3, chunk 12
      // follow-up B): PUT used to return 422 for the same condition.
      if ("notFound" in result && result.notFound) return jsonError("Address not found.", 404);
      return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });
    }
    return jsonOk({ address: result.address });
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const user = await requireUser();
    const limited = addressWriteLimit(user.id);
    if (limited) return limited;
    const { id } = await ctx.params;
    const result = await deleteAddress(user.id, id);
    if (!result.ok) return jsonError("Address not found.", 404);
    // The server promotes a new default when the deleted address was the
    // default (Phase 3, chunk 12 follow-up B) — the client updates its
    // local state from promotedId instead of issuing a second PUT.
    return jsonOk({ deleted: true, promotedId: result.promotedId });
  });
}
