// Address create (FR-05). Ownership enforced via session userId (NFR-11).
import { createAddress } from "@/services/users.service";
import { requireUser } from "@/lib/auth-guard";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const body = await request.json().catch(() => null);
    if (!body) return jsonError("Invalid request body", 400);
    const result = await createAddress(user.id, body);
    if (!result.ok) return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });
    return jsonOk({ address: result.address });
  });
}
