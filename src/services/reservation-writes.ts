import type { db } from "@/lib/db";
type ApplicationTransaction = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export class ReservationWriteConflict extends Error {
  constructor(message = "Stock changed or has active payment reservations. Refresh before editing stock.") {
    super(message);
  }
}

/** Absolute stock edits must lock the same row as checkout before inspecting holds.
 *
 *  variantId selects which row: null/absent = the product-level row,
 *  set = that variant's row (Phase 3, Chunk 8 — D12). The lookup is a
 *  findFirst, not a findUnique on the (productId, variantId) compound key:
 *  Prisma rejects null inside a compound-unique `where` ("Argument
 *  variantId must not be null"), and findFirst with `variantId: null`
 *  correctly means IS NULL. The (productId, variantId) uniqueness is
 *  enforced by the compound unique + the partial unique index in migration
 *  20261120000003, so the findFirst can return at most one row. */
export async function writeAvailableStock(tx: ApplicationTransaction, input: {
  productId: string; variantId?: string | null; quantity: number; lowStockThreshold?: number;
}) {
  const inventory = await tx.inventory.findFirst({ where: { productId: input.productId, variantId: input.variantId ?? null } });
  if (!inventory) {
    await tx.inventory.create({ data: { productId: input.productId, variantId: input.variantId ?? null, quantity: input.quantity, lowStockThreshold: input.lowStockThreshold ?? 5 } });
    return;
  }
  if (await tx.inventoryReservation.count({ where: { inventoryId: inventory.id, state: "HELD" } }))
    throw new ReservationWriteConflict();
  // One version-gated write (M-16): every quantity writer bumps `version`
  // (COD decrement, Safepay hold/release, restores), so a sale that lands
  // between the read above and this write fails the predicate instead of
  // being silently overwritten by the absolute value. The previous two-step
  // form (bump the version, then an ungated absolute update) left exactly
  // that window open: the bump protected the read, not the write.
  if ((await tx.inventory.updateMany({
    where: { id: inventory.id, version: inventory.version },
    data: {
      quantity: input.quantity,
      version: { increment: 1 },
      ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
    },
  })).count !== 1) throw new ReservationWriteConflict();
}
