// Admin: inventory update (FR-40, FR-46 — validated, never negative).
import { adminUpdateInventory } from "@/services/inventory.service";
import { inventoryUpdateSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, handleRoute, parseBody } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export async function PUT(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-inventory-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    // Stage 3 audit, L-5: parseBody caps the body at 1 MiB (the old
    // request.json() had no cap) and validates against the same schema
    // the service uses, so invalid input still maps to 422 with field
    // errors.
    const parsed = await parseBody(request, inventoryUpdateSchema);
    if (parsed.error) return parsed.error;
    const body = parsed.data;
    const result = await adminUpdateInventory(body);
    if (!result.ok) {
      // Stage 3 audit, M-6: a missing product or variant is 404 (the
      // service returns a code for those); validation and reservation
      // conflicts stay 422.
      const status = "code" in result && result.code ? 404 : 422;
      return jsonError(result.error, status);
    }
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.INVENTORY_UPDATED,
      targetType: "Inventory",
      targetId: typeof body.productId === "string" ? body.productId : null,
      metadata: { quantity: body.quantity, ...(typeof body.variantId === "string" ? { variantId: body.variantId } : {}) },
    });
    return jsonOk({});
  });
}
