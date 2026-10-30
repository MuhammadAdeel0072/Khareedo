// Admin: inventory update (FR-40, FR-46 — validated, never negative).
import { adminUpdateInventory } from "@/services/inventory.service";
import { requireAdmin } from "@/lib/auth-guard";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";

export async function PUT(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const body = await request.json().catch(() => null);
    if (!body) return jsonError("Invalid request body", 400);
    const result = await adminUpdateInventory(body);
    if (!result.ok) return jsonError(result.error, 422);
    return jsonOk({});
  });
}
