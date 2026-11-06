// Admin: read / update / archive product (FR-39, BR-14, NFR-31 — soft archive).
import { adminGetProduct, adminUpdateProduct, adminArchiveProduct } from "@/services/products.service";
import { productSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  productWriteErrorResponse,
  validateProductCategory,
} from "@/lib/product-api-errors";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const product = await adminGetProduct(id);
    if (!product) return jsonError("Product not found", 404);
    return jsonOk({ product });
  });
}

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const parsed = await parseBody(request, productSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    if (
      d.comparePrice !== undefined &&
      d.comparePrice !== null &&
      d.comparePrice <= d.price
    ) {
      return jsonError("Compare-at price must be higher than the selling price.", 422, {
        errors: { comparePrice: "Must be higher than the selling price" },
      });
    }
    const categoryError = await validateProductCategory(d.categoryId);
    if (categoryError) return categoryError;
    try {
      const product = await adminUpdateProduct(id, {
        name: d.name,
        slug: d.slug || undefined,
        description: d.description,
        brand: d.brand || undefined,
        sku: d.sku || undefined,
        categoryId: d.categoryId,
        price: d.price,
        comparePrice: d.comparePrice ?? null,
        status: d.status,
        isFeatured: d.isFeatured,
        rating: d.rating,
        reviewCount: d.reviewCount,
        tags: d.tags || undefined,
        images: d.images,
        stock: d.stock,
        lowStockThreshold: d.lowStockThreshold,
      });
      return jsonOk({ product });
    } catch (error) {
      const response = productWriteErrorResponse(error);
      if (response) return response;
      throw error;
    }
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    await adminArchiveProduct(id);
    return jsonOk({});
  });
}
