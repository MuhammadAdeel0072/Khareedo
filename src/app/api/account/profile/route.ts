// Profile update (FR-05).
import { updateProfile } from "@/services/users.service";
import { requireUser } from "@/lib/auth-guard";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";

export async function PUT(request: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const body = await request.json().catch(() => null);
    if (!body) return jsonError("Invalid request body", 400);
    const result = await updateProfile(user.id, body);
    if (!result.ok) return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });
    return jsonOk({});
  });
}
