// Product variants service (Phase 3, Chunk 8 — D12).
//
// Denormalised label-string model: one variant = one row with a plain label
// ("Size: M / Colour: Red"), an absolute price override (null = inherit the
// product price), and its own Inventory row. A null variantId on a cart or
// order line means the product itself — existing products keep working with
// no backfill. No variant images, no variant filtering in V1.
import { db } from "@/lib/db";
import { writeAvailableStock } from "@/services/reservation-writes";

export class VariantUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariantUnavailableError";
  }
}

export class VariantSkuConflictError extends Error {
  constructor(
    message: string,
    public readonly sku: string
  ) {
    super(message);
    this.name = "VariantSkuConflictError";
  }
}

// The transaction client type, not Prisma.TransactionClient: the app adds
// query timing through $extends, and the extended client is not
// structurally assignable to the plain TransactionClient (same workaround
// as updateManagedOrderStatus in safepay-reservations.service.ts).
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** Any inventory row as read through a product include (inventory is a
 *  list now — one row per (productId, variantId)). */
export interface InventoryRowLike {
  variantId: string | null;
  quantity: number;
  /** Not every caller selects the threshold — inventoryForVariant only
   *  needs variantId + quantity. */
  lowStockThreshold?: number;
}

/** The inventory row that backs one line: the variant's row, or the
 *  product-level row (variantId null) for variant-less lines. */
export function inventoryForVariant<T extends InventoryRowLike>(
  rows: T[] | null | undefined,
  variantId?: string | null
): T | undefined {
  if (!rows) return undefined;
  const wanted = variantId ?? null;
  return rows.find((r) => r.variantId === wanted);
}

/** Total available stock across every row of a product (product-level +
 *  all variants) — what storefront list cards, the PDP header and the
 *  wishlist show. Per-variant availability is what the PDP selector and
 *  the cart use. */
export function totalProductStock(rows: Array<{ quantity: number }> | null | undefined): number {
  if (!rows) return 0;
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

/** Effective unit price of a line: the variant's ABSOLUTE override when
 *  set, otherwise the product price. Computed server-side only — the money
 *  path never trusts a client-submitted price (Chunk 1). */
export function effectiveVariantPrice(
  productPrice: number,
  variant: { priceOverride: number | null } | null | undefined
): number {
  return variant?.priceOverride ?? productPrice;
}

export interface VariantDetail {
  id: string;
  productId: string;
  label: string;
  sku: string;
  priceOverride: number | null;
  isActive: boolean;
  sortOrder: number;
  stock: number;
  lowStockThreshold: number;
}

function toVariantDetail(v: {
  id: string;
  productId: string;
  label: string;
  sku: string;
  priceOverride: number | null;
  isActive: boolean;
  sortOrder: number;
  inventory: { quantity: number; lowStockThreshold: number } | null;
}): VariantDetail {
  return {
    id: v.id,
    productId: v.productId,
    label: v.label,
    sku: v.sku,
    priceOverride: v.priceOverride,
    isActive: v.isActive,
    sortOrder: v.sortOrder,
    stock: v.inventory?.quantity ?? 0,
    lowStockThreshold: v.inventory?.lowStockThreshold ?? 5,
  };
}

/** Active (sellable) variants of a product, with per-variant stock — the
 *  PDP selector and the admin variant list read from here. */
export async function listProductVariants(
  productId: string,
  opts: { activeOnly?: boolean } = {}
): Promise<VariantDetail[]> {
  const rows = await db.productVariant.findMany({
    where: { productId, ...(opts.activeOnly ? { isActive: true } : {}) },
    include: { inventory: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toVariantDetail);
}

/**
 * Resolve + validate one variant for a line (cart/checkout/Safepay).
 * Throws VariantUnavailableError when the variant does not exist, belongs
 * to another product, or is inactive. Returns the variant with its
 * inventory row (null when the row is missing — callers treat that as
 * zero stock, never as unlimited).
 */
export async function getVariantForLine(
  tx: Tx,
  productId: string,
  variantId: string
): Promise<{
  id: string;
  productId: string;
  label: string;
  sku: string;
  priceOverride: number | null;
  isActive: boolean;
  inventory: { id: string; quantity: number } | null;
}> {
  const variant = await tx.productVariant.findFirst({
    where: { id: variantId, productId },
    include: { inventory: true },
  });
  if (!variant) {
    throw new VariantUnavailableError("This variant is no longer available");
  }
  if (!variant.isActive) {
    throw new VariantUnavailableError(`"${variant.label}" is no longer available`);
  }
  return variant;
}

/** Variant SKUs are unique across BOTH ProductVariant.sku and Product.sku
 *  (the product SKU is the import/export key, so a collision across the
 *  two tables would make a variant indistinguishable from a product). */
export async function assertVariantSkuFree(tx: Tx, sku: string, excludeVariantId?: string): Promise<void> {
  const [variantClash, productClash] = await Promise.all([
    tx.productVariant.findFirst({
      where: { sku, ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}) },
      select: { id: true },
    }),
    tx.product.findFirst({ where: { sku }, select: { id: true } }),
  ]);
  if (variantClash || productClash) {
    throw new VariantSkuConflictError(`SKU "${sku}" is already in use`, sku);
  }
}

export interface VariantWriteInput {
  label: string;
  sku: string;
  priceOverride?: number | null;
  stock: number;
  lowStockThreshold?: number;
  sortOrder?: number;
  isActive?: boolean;
}

export async function createVariant(productId: string, input: VariantWriteInput): Promise<VariantDetail> {
  return db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new Error("Product not found");
    await assertVariantSkuFree(tx, input.sku);
    const variant = await tx.productVariant.create({
      data: {
        productId,
        label: input.label,
        sku: input.sku,
        priceOverride: input.priceOverride ?? null,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    const inventory = await tx.inventory.create({
      data: {
        productId,
        variantId: variant.id,
        quantity: input.stock,
        lowStockThreshold: input.lowStockThreshold ?? 5,
      },
    });
    return toVariantDetail({ ...variant, inventory });
  });
}

export async function updateVariant(
  productId: string,
  variantId: string,
  input: Partial<VariantWriteInput>
): Promise<VariantDetail> {
  return db.$transaction(async (tx) => {
    // The variant must belong to the product in the URL — a variant id
    // from another product is a 404, never a cross-product write.
    const existing = await tx.productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true, productId: true, sku: true },
    });
    if (!existing) throw new VariantUnavailableError("Variant not found");
    if (input.sku && input.sku !== existing.sku) {
      await assertVariantSkuFree(tx, input.sku, variantId);
    }
    // Stock goes through the same version-gated writer as every other
    // absolute stock edit (M-16): a concurrent sale between the read and
    // this write fails instead of being silently overwritten.
    if (input.stock !== undefined) {
      await writeAvailableStock(tx, {
        productId: existing.productId,
        variantId,
        quantity: input.stock,
        lowStockThreshold: input.lowStockThreshold,
      });
    }
    const updated = await tx.productVariant.update({
      where: { id: variantId },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.sku !== undefined ? { sku: input.sku } : {}),
        ...(input.priceOverride !== undefined ? { priceOverride: input.priceOverride } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      include: { inventory: true },
    });
    return toVariantDetail(updated);
  });
}

/** Deactivation is the V1 removal path — there is no hard delete: a
 *  variant may already sit on order lines (history must survive), and an
 *  inactive variant can no longer be added to a cart or ordered. */
export async function setVariantActive(productId: string, variantId: string, isActive: boolean) {
  return updateVariant(productId, variantId, { isActive });
}
