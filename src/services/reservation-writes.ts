import type { db } from "@/lib/db";
type ApplicationTransaction = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export class ReservationWriteConflict extends Error {
  constructor(message = "Stock changed or has active payment reservations. Refresh before editing stock.") {
    super(message);
  }
}

/** Absolute stock edits must lock the same row as checkout before inspecting holds. */
export async function writeAvailableStock(tx: ApplicationTransaction, input: {
  productId: string; quantity: number; lowStockThreshold?: number;
}) {
  const inventory = await tx.inventory.findUnique({ where: { productId: input.productId } });
  if (!inventory) {
    await tx.inventory.create({ data: { ...input, lowStockThreshold: input.lowStockThreshold ?? 5 } });
    return;
  }
  if ((await tx.inventory.updateMany({
    where: { id: inventory.id, version: inventory.version }, data: { version: { increment: 1 } },
  })).count !== 1) throw new ReservationWriteConflict();
  if (await tx.inventoryReservation.count({ where: { inventoryId: inventory.id, state: "HELD" } }))
    throw new ReservationWriteConflict();
  await tx.inventory.update({ where: { id: inventory.id }, data: {
    quantity: input.quantity,
    ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
  } });
}
