// Admin: product variant management (Chunk 8 — D12).
// GET lists a product's variants; POST creates one (with its own stock row).
import { listProductVariants, createVariant, VariantSkuConflictError } from "@/services/variants.service";
import { variantSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdminMfaVerified();
    const { id } = await ctx.params;
    const product = await db.product.findFirst({ where: { id }, select: { id: true } });
    if (!product) return jsonError("Product not found", 404);
    const variants = await listProductVariants(id, { activeOnly: false });
    return jsonOk({ variants });
  });
}

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
    const parsed = await parseBody(request, variantSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    try {
      const variant = await createVariant(id, {
        label: d.label,
        sku: d.sku,
        priceOverride: d.priceOverride ?? null,
        stock: d.stock,
        lowStockThreshold: d.lowStockThreshold,
        sortOrder: d.sortOrder,
      });
      await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
        action: ADMIN_AUDIT_ACTIONS.PRODUCT_UPDATED,
        targetType: "ProductVariant",
        targetId: variant.id,
        metadata: { productId: id, label: d.label, sku: d.sku },
      });
      return jsonOk({ variant }, { status: 201 });
    } catch (error) {
      if (error instanceof VariantSkuConflictError) {
        return jsonError(error.message, 409, { errors: { sku: "SKU is already in use" } });
      }
      if (error instanceof Error && error.message === "Product not found") {
        return jsonError("Product not found", 404);
      }
      throw error;
    }
  });
}
