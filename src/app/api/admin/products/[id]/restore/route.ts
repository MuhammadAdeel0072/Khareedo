// Admin: restore an archived product (Phase 3, Chunk 5 — M-1). Reverses
// exactly what the DELETE/archive endpoint does: clears the soft-delete
// marker and returns the product to DRAFT (never auto-publish).
import { adminGetProduct, adminRestoreProduct } from "@/services/products.service";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-products-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const { id } = await ctx.params;
    const product = await adminGetProduct(id);
    if (!product) return jsonError("Product not found", 404);
    const result = await adminRestoreProduct(id);
    if (!result.ok) return jsonError(result.reason ?? "This product cannot be restored.", 409);
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.PRODUCT_RESTORED,
      targetType: "Product",
      targetId: id,
      metadata: { name: product.name },
    });
    return jsonOk({ product: { ...product, status: "DRAFT", deletedAt: null } });
  });
}
