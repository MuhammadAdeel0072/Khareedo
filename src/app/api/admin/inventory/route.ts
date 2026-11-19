// Admin: inventory update (FR-40, FR-46 — validated, never negative).
import { adminUpdateInventory } from "@/services/inventory.service";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export async function PUT(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const body = await request.json().catch(() => null);
    if (!body) return jsonError("Invalid request body", 400);
    const result = await adminUpdateInventory(body);
    if (!result.ok) return jsonError(result.error, 422);
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.INVENTORY_UPDATED,
      targetType: "Inventory",
      targetId: typeof body.productId === "string" ? body.productId : null,
      metadata: { quantity: body.quantity },
    });
    return jsonOk({});
  });
}
