// Admin: update one product variant (Chunk 8 — D12).
// PATCH edits label / SKU / price override / active flag / stock / sort order.
// There is no DELETE in V1 — deactivation (isActive: false) is the removal
// path, so order history that snapshots the variant survives.
import { updateVariant, VariantSkuConflictError, VariantUnavailableError } from "@/services/variants.service";
import { variantUpdateSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

type Ctx = { params: Promise<{ id: string; variantId: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-products-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const { id, variantId } = await ctx.params;
    const parsed = await parseBody(request, variantUpdateSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    try {
      const variant = await updateVariant(id, variantId, {
        label: d.label,
        sku: d.sku,
        priceOverride: d.priceOverride,
        isActive: d.isActive,
        sortOrder: d.sortOrder,
        stock: d.stock,
        lowStockThreshold: d.lowStockThreshold,
      });
      await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
        action: ADMIN_AUDIT_ACTIONS.PRODUCT_UPDATED,
        targetType: "ProductVariant",
        targetId: variant.id,
        metadata: { productId: id, label: variant.label, sku: variant.sku },
      });
      return jsonOk({ variant });
    } catch (error) {
      if (error instanceof VariantSkuConflictError) {
        return jsonError(error.message, 409, { errors: { sku: "SKU is already in use" } });
      }
      if (error instanceof VariantUnavailableError) {
        return jsonError(error.message, 404);
      }
      throw error;
    }
  });
}
