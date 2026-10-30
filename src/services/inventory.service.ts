// Inventory service — stock visibility & authorized updates (FR-40, FR-45, BR-14).
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import { inventoryUpdateSchema } from "@/lib/validation";

export interface InventoryRow {
  productId: string;
  productName: string;
  category: string;
  quantity: number;
  lowStockThreshold: number;
  isLow: boolean;
  isOut: boolean;
  status: string;
}

export async function adminListInventory(q?: string, filter?: string) {
  const where: Prisma.ProductWhereInput = { deletedAt: null };
  if (q) where.name = { contains: q.trim() };

  const products = await db.product.findMany({
    where,
    include: {
      inventory: true,
      category: { select: { name: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });

  let rows: InventoryRow[] = products.map((p) => {
    const quantity = p.inventory?.quantity ?? 0;
    const threshold = p.inventory?.lowStockThreshold ?? 5;
    return {
      productId: p.id,
      productName: p.name,
      category: p.category.name,
      quantity,
      lowStockThreshold: threshold,
      isLow: quantity > 0 && quantity <= threshold,
      isOut: quantity <= 0,
      status: p.status,
    };
  });

  if (filter === "low") rows = rows.filter((r) => r.isLow);
  if (filter === "out") rows = rows.filter((r) => r.isOut);
  return rows;
}

export async function getLowStockProducts(limit = 6) {
  const products = await db.product.findMany({
    where: {
      deletedAt: null,
      status: "PUBLISHED",
      inventory: { quantity: { lte: 5 } },
    },
    include: { inventory: true, images: { take: 1, orderBy: { sortOrder: "asc" } } },
    orderBy: { inventory: { quantity: "asc" } },
    take: limit,
  });
  return products.map((p) => ({
    productId: p.id,
    name: p.name,
    image: p.images[0]?.url ?? null,
    quantity: p.inventory?.quantity ?? 0,
    price: p.price,
  }));
}

/** Authorized stock update with validation (never negative, FR-40). */
export async function adminUpdateInventory(input: {
  productId: string;
  quantity: number;
  lowStockThreshold?: number;
}) {
  const parsed = inventoryUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid stock value" };
  }
  const { productId, quantity, lowStockThreshold } = parsed.data;
  const existing = await db.inventory.findUnique({ where: { productId } });
  if (existing) {
    await db.inventory.update({
      where: { productId },
      data: {
        quantity,
        ...(lowStockThreshold !== undefined ? { lowStockThreshold } : {}),
      },
    });
  } else {
    await db.inventory.create({
      data: {
        productId,
        quantity,
        lowStockThreshold: lowStockThreshold ?? 5,
      },
    });
  }
  return { ok: true as const };
}
