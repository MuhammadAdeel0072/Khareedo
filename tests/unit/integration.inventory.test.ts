// Integration test — inventory hardening (Phase 3, Chunk 12 follow-up A).
// Run with: npm run test:db
//
// Covers M-15 (CHECK quantity >= 0 on Inventory), M-16 (admin absolute
// stock write vs concurrent COD sale — lost update), M-18 (inventory ↔
// reservation drift detection) and M-8b/c (per-product low-stock
// thresholds, held quantities in admin inventory) against the real Prisma
// layer on a disposable SQLite database. All assertions are scoped to this
// file's own fixtures: the harness shares one database across files in a
// run, so other suites' products/orders may exist alongside ours.
//
// SQLite serialises writers, so the M-16 concurrent test cannot prove the
// race the way Postgres would (see the audit's §(g) G4 note): it asserts
// the no-lost-update invariant — every interleaving must end in a state
// consistent with both operations having been applied — and the
// deterministic protection is the version-gated write in
// reservation-writes.ts, which every quantity writer's version bump feeds.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

import { db } from "@/lib/db";
import {
  adminListInventory,
  adminUpdateInventory,
  getInventoryReservationDrift,
  getLowStockProducts,
} from "@/services/inventory.service";
import { ReservationWriteConflict, writeAvailableStock } from "@/services/reservation-writes";

assertDisposableTestDatabase();

const NOW = new Date("2026-11-20T00:00:00.000Z");
const created = {
  reservations: [] as string[],
  orders: [] as string[],
  products: [] as string[],
  categories: [] as string[],
};

afterAll(async () => {
  await db.inventoryReservation.deleteMany({ where: { id: { in: created.reservations } } });
  await db.order.deleteMany({ where: { id: { in: created.orders } } });
  await db.product.deleteMany({ where: { id: { in: created.products } } });
  await db.category.deleteMany({ where: { id: { in: created.categories } } });
  await db.$disconnect();
});

async function seedProduct(quantity: number, options: { name?: string; threshold?: number; status?: string } = {}) {
  const category = await db.category.create({
    data: { name: "Synthetic " + randomUUID(), slug: randomUUID() },
  });
  created.categories.push(category.id);
  const product = await db.product.create({
    data: {
      name: options.name ?? "Synthetic watch",
      slug: randomUUID(),
      categoryId: category.id,
      status: options.status ?? "PUBLISHED",
      price: 1000,
      inventory: { create: { quantity, lowStockThreshold: options.threshold ?? 5 } },
    },
    include: { inventory: true },
  });
  created.products.push(product.id);
  return product;
}

async function seedHeldOrder(options: {
  stock?: number;
  status?: string;
  paymentStatus?: string;
  paymentReviewStatus?: string | null;
  reservationExpiresAt?: Date | null;
  holdQuantity?: number;
  itemQuantity?: number;
  reservationState?: string;
}) {
  const product = await seedProduct(options.stock ?? 10);
  const inventory = product.inventory.find((r) => r.variantId === null)!;
  const order = await db.order.create({
    data: {
      reference: "KH" + randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      idempotencyKey: randomUUID(),
      customerName: "Drift Buyer",
      customerEmail: "drift@example.invalid",
      customerPhone: "03000000000",
      shipFullName: "Drift Buyer",
      shipPhone: "03000000000",
      shipLine1: "Street 1",
      shipCity: "Lahore",
      shipProvince: "Punjab",
      status: options.status ?? "PENDING",
      paymentMethod: "ONLINE",
      paymentStatus: options.paymentStatus ?? "PENDING",
      paymentReviewStatus: options.paymentReviewStatus ?? null,
      reservationExpiresAt: options.reservationExpiresAt ?? null,
      subtotal: 2000,
      total: 2000,
      items: {
        create: {
          productId: product.id,
          productName: product.name,
          productSlug: product.slug,
          unitPrice: 1000,
          quantity: options.itemQuantity ?? 2,
          lineTotal: 2000,
        },
      },
    },
    include: { items: true },
  });
  created.orders.push(order.id);
  const reservation = await db.inventoryReservation.create({
    data: {
      orderItemId: order.items[0].id,
      inventoryId: inventory.id,
      quantity: options.holdQuantity ?? 2,
      state: options.reservationState ?? "HELD",
      // The state CHECK (mirrored in both schemas' constraints) requires a
      // timestamp to match the state: CONSUMED needs consumedAt set.
      consumedAt: options.reservationState === "CONSUMED" ? NOW : null,
    },
  });
  created.reservations.push(reservation.id);
  return { product, order, item: order.items[0], reservation };
}

async function stockOf(productId: string) {
  return db.inventory.findFirstOrThrow({ where: { productId, variantId: null } });
}

describe("M-15 CHECK (quantity >= 0)", () => {
  it("the quantity CHECK triggers are installed in the test database", async () => {
    const rows = await db.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'Inventory_quantity_check_%' ORDER BY name"
    );
    expect(rows.map((r) => r.name)).toEqual([
      "Inventory_quantity_check_insert",
      "Inventory_quantity_check_update",
    ]);
  });

  // Prisma maps the SQLite trigger abort to its generic constraint error
  // (P2003 "Foreign key constraint violated") — the trigger name does not
  // survive the mapping. What these tests prove at the database level is
  // that the write is rejected and the stock is left untouched; the
  // trigger-presence test above ties that rejection to the CHECK.
  it("a decrement below zero fails at the database and leaves stock unchanged", async () => {
    const product = await seedProduct(3, { name: "Check Watch" });
    await expect(
      db.inventory.updateMany({
        where: { productId: product.id, variantId: null },
        data: { quantity: { decrement: 4 } },
      })
    ).rejects.toThrow();
    expect((await stockOf(product.id)).quantity).toBe(3);
  });

  it("a direct negative set fails at the database", async () => {
    const product = await seedProduct(3, { name: "Negative Watch" });
    await expect(
      db.inventory.updateMany({ where: { productId: product.id, variantId: null }, data: { quantity: -1 } })
    ).rejects.toThrow();
    expect((await stockOf(product.id)).quantity).toBe(3);
  });

  it("a decrement to exactly zero succeeds", async () => {
    const product = await seedProduct(3, { name: "Zero Watch" });
    await db.inventory.updateMany({
      where: { productId: product.id, variantId: null },
      data: { quantity: { decrement: 3 } },
    });
    expect((await stockOf(product.id)).quantity).toBe(0);
  });
});

describe("M-16 admin absolute write vs COD sale", () => {
  it("sequential admin writes apply in order", async () => {
    const product = await seedProduct(10, { name: "Sequential Watch" });
    expect(await adminUpdateInventory({ productId: product.id, quantity: 20 })).toEqual({ ok: true });
    expect(await adminUpdateInventory({ productId: product.id, quantity: 15 })).toEqual({ ok: true });
    expect((await stockOf(product.id)).quantity).toBe(15);
  });

  it("a HELD reservation blocks the absolute write (the HELD-block)", async () => {
    const { product } = await seedHeldOrder({ stock: 10 });
    const before = await stockOf(product.id);
    // writeAvailableStock reads the current version inside the transaction
    // and version-gates its single write, so there is no caller-side version
    // to reuse — the deterministic half of the guard is this HELD-block,
    // and the version half is pinned by the concurrent tests below.
    await expect(
      db.$transaction((tx) => writeAvailableStock(tx, { productId: product.id, quantity: 20 }))
    ).rejects.toThrow(ReservationWriteConflict);
    expect((await stockOf(product.id)).quantity).toBe(before.quantity);
  });

  it("two concurrent admin writes never lose one silently", async () => {
    const product = await seedProduct(10, { name: "Race Watch" });
    const results = await Promise.allSettled([
      adminUpdateInventory({ productId: product.id, quantity: 20 }),
      adminUpdateInventory({ productId: product.id, quantity: 30 }),
    ]);
    const outcomes = results.map((r) =>
      r.status === "fulfilled" ? (r as PromiseFulfilledResult<{ ok: boolean; error?: string }>).value : null
    );
    // SQLite serialises writers, so the second write may legitimately
    // re-read the first write's version and succeed (final 30), or read a
    // stale version and be refused (final 20, error asks for a refresh).
    // Either way the final stock is exactly one of the two writes — never
    // a blend, never a silent overwrite of the other.
    expect(outcomes.every((o) => o !== null)).toBe(true);
    expect(outcomes.some((o) => o!.ok)).toBe(true);
    for (const o of outcomes.filter((o) => !o!.ok)) {
      expect(o!.error).toMatch(/Stock changed/);
    }
    expect((await stockOf(product.id)).quantity).toBeOneOf([20, 30]);
  });

  it("concurrent admin write and COD-style decrement never lose the sale", async () => {
    const product = await seedProduct(10, { name: "COD Race Watch" });
    const results = await Promise.allSettled([
      adminUpdateInventory({ productId: product.id, quantity: 20 }),
      // The exact COD decrement predicate (checkout.service.ts): quantity
      // floor + relative decrement + version bump, no version predicate.
      db.inventory.updateMany({
        where: { productId: product.id, quantity: { gte: 3 } },
        data: { quantity: { decrement: 3 }, version: { increment: 1 } },
      }),
    ]);
    const admin = results[0] as PromiseFulfilledResult<{ ok: boolean; error?: string }>;
    expect(admin.status).toBe("fulfilled");
    const final = await stockOf(product.id);
    if (admin.value.ok) {
      // Admin read after the sale (qty 7 → set 20) or before it (set 20,
      // then the sale decremented to 17). Either way both operations are
      // reflected: the version advanced once per writer.
      expect(final.quantity).toBeOneOf([17, 20]);
      expect(final.version).toBe(2);
    } else {
      // The sale landed between the admin's read and write: the version
      // gate refused the stale absolute write instead of overwriting the
      // decremented stock, and the admin must refresh.
      expect(admin.value.error).toMatch(/Stock changed/);
      expect(final.quantity).toBe(7);
      expect(final.version).toBe(1);
    }
  });
});

describe("M-18 inventory ↔ reservation drift", () => {
  it("reports a HELD reservation on a closed order", async () => {
    const { reservation } = await seedHeldOrder({ status: "CANCELLED" });
    const drift = await getInventoryReservationDrift(NOW);
    const found = drift.items.find((i) => i.reservationId === reservation.id);
    expect(found).toBeDefined();
    expect(found!.reasons).toContain("ORDER_CLOSED");
    expect(found!.heldQuantity).toBe(2);
  });

  it("does not report a hold retained for payment review", async () => {
    const { reservation } = await seedHeldOrder({
      status: "CANCELLED",
      paymentReviewStatus: "REQUIRED",
    });
    const drift = await getInventoryReservationDrift(NOW);
    expect(drift.items.some((i) => i.reservationId === reservation.id)).toBe(false);
  });

  it("reports a HELD reservation on a settled order", async () => {
    const { reservation } = await seedHeldOrder({ status: "CONFIRMED" });
    const drift = await getInventoryReservationDrift(NOW);
    const found = drift.items.find((i) => i.reservationId === reservation.id);
    expect(found).toBeDefined();
    expect(found!.reasons).toContain("ORDER_SETTLED");
  });

  it("reports a held quantity that disagrees with the order line", async () => {
    const { reservation } = await seedHeldOrder({
      status: "PENDING",
      reservationExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      holdQuantity: 1,
      itemQuantity: 2,
    });
    const drift = await getInventoryReservationDrift(NOW);
    const found = drift.items.find((i) => i.reservationId === reservation.id);
    expect(found).toBeDefined();
    expect(found!.reasons).toContain("QUANTITY_MISMATCH");
    expect(found!.orderItemQuantity).toBe(2);
  });

  it("reports a reservation past expiry on an open checkout", async () => {
    const { reservation } = await seedHeldOrder({
      status: "PENDING",
      reservationExpiresAt: new Date("2026-11-19T00:00:00.000Z"),
    });
    const drift = await getInventoryReservationDrift(NOW);
    const found = drift.items.find((i) => i.reservationId === reservation.id);
    expect(found).toBeDefined();
    expect(found!.reasons).toContain("EXPIRED");
  });

  it("does not report a live hold", async () => {
    const { reservation } = await seedHeldOrder({
      status: "PENDING",
      reservationExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    const drift = await getInventoryReservationDrift(NOW);
    expect(drift.items.some((i) => i.reservationId === reservation.id)).toBe(false);
  });

  it("does not report a consumed reservation on a settled order", async () => {
    const { reservation } = await seedHeldOrder({
      status: "CONFIRMED",
      reservationState: "CONSUMED",
    });
    const drift = await getInventoryReservationDrift(NOW);
    expect(drift.items.some((i) => i.reservationId === reservation.id)).toBe(false);
  });
});

describe("M-8b/c low stock and held quantities", () => {
  it("getLowStockProducts respects per-product thresholds", async () => {
    const belowOwn = await seedProduct(3, { name: "Below Own Watch", threshold: 2 });
    const aboveOwn = await seedProduct(8, { name: "Above Own Watch", threshold: 10 });
    const zero = await seedProduct(0, { name: "Zero Watch", threshold: 5 });
    const aboveDefault = await seedProduct(6, { name: "Above Default Watch", threshold: 5 });
    const mine = new Set([belowOwn.id, aboveOwn.id, zero.id, aboveDefault.id]);
    // Wide window, not the 50-row default: the disposable DB is shared
    // with every other suite (and vitest does not run files in CLI order),
    // so dozens of other suites' low-stock products fill the lowest 50 and
    // would push `aboveOwn` (qty 8) out of a narrow window. Membership is
    // what this test asserts; the 50-row limit itself is covered by the
    // panic test below.
    const listed = (await getLowStockProducts(5000)).filter((p) => mine.has(p.productId));
    const listedIds = new Set(listed.map((p) => p.productId));
    expect(listedIds.has(belowOwn.id)).toBe(false);
    expect(listedIds.has(aboveOwn.id)).toBe(true);
    expect(listedIds.has(zero.id)).toBe(true);
    expect(listedIds.has(aboveDefault.id)).toBe(false);
    expect(listed.find((p) => p.productId === aboveOwn.id)?.quantity).toBe(8);
  });

  it("does not panic when the catalogue exceeds ~1000 published products", async () => {
    // Regression: the old implementation selected `images: { take: 1,
    // orderBy: { sortOrder: "asc" } }` on the unbounded parent query, and
    // the Prisma query engine panics (`no entry found for key`) once the
    // parent set passes ~1,003 rows. In the full suite this surfaced only
    // when the performance file (1,000 bulk products) ran before this
    // file — vitest does not run files in CLI order — so it looked like a
    // flaky, order-dependent failure. Seeding 1,010 published products
    // here trips the old code deterministically (verified fail-first).
    const prefix = "bulk-low-" + randomUUID();
    const category = await db.category.create({
      data: { name: "Bulk Low " + randomUUID(), slug: randomUUID() },
    });
    created.categories.push(category.id);
    const ids: string[] = Array.from({ length: 1010 }, () => randomUUID());
    await db.product.createMany({
      data: ids.map((id, i) => ({
        id,
        name: `Bulk Low ${i}`,
        slug: `${prefix}-${i}`,
        categoryId: category.id,
        status: "PUBLISHED",
        price: 1000,
      })),
    });
    created.products.push(...ids);
    await db.inventory.createMany({
      data: ids.map((productId) => ({ productId, quantity: 1, lowStockThreshold: 5 })),
    });
    // The panic needs image rows present as well as >~1,003 parents: with
    // no images at all the old query survives even at 1,025 parents.
    const imagedIds = ids.slice(0, 5);
    await db.productImage.createMany({
      data: imagedIds.map((productId) => ({
        productId,
        url: "/bulk-low-first.png",
        sortOrder: 0,
      })),
    });
    try {
      // Limit still respected.
      const rows = await getLowStockProducts(50);
      expect(rows.length).toBe(50);
      // The no-panic proof must not depend on which other low-stock rows
      // share the disposable DB (the performance file seeds ~1,000 of its
      // own, and vitest does not run files in CLI order): fetch a wide
      // window and assert every seeded product is present and correct.
      const all = await getLowStockProducts(5000);
      const mine = all.filter((r) => ids.includes(r.productId));
      expect(mine.length).toBe(1010);
      expect(mine.every((r) => r.quantity === 1)).toBe(true);
      const imagedInRows = all.filter((r) => imagedIds.includes(r.productId));
      expect(imagedInRows.length).toBe(5);
      expect(imagedInRows.every((r) => r.image === "/bulk-low-first.png")).toBe(true);
      expect(
        all
          .filter((r) => ids.includes(r.productId) && !imagedIds.includes(r.productId))
          .every((r) => r.image === null)
      ).toBe(true);
    } finally {
      await db.productImage.deleteMany({ where: { productId: { in: ids } } });
      await db.inventory.deleteMany({ where: { productId: { in: ids } } });
      await db.product.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it("adminListInventory reports held quantities per product", async () => {
    const held = await seedHeldOrder({ stock: 5 });
    const plain = await seedProduct(4, { name: "Plain Watch" });
    const { rows } = await adminListInventory();
    const heldRow = rows.find((r) => r.productId === held.product.id);
    const plainRow = rows.find((r) => r.productId === plain.id);
    expect(heldRow).toBeDefined();
    expect(heldRow!.quantity).toBe(5);
    expect(heldRow!.heldQuantity).toBe(2);
    expect(plainRow).toBeDefined();
    expect(plainRow!.heldQuantity).toBe(0);
  });

  it("adminListInventory paginates instead of silently capping at 200 rows", async () => {
    // Seed 6 products with a unique name prefix, then page through them 2
    // at a time: pages must be disjoint and cover the whole set.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await seedProduct(3, { name: `Pageable Watch ${i}` });
      ids.push(p.id);
    }
    const q = "Pageable Watch";
    const first = await adminListInventory({ q, page: 1, perPage: 2 });
    expect(first.total).toBe(6);
    expect(first.pages).toBe(3);
    expect(first.rows).toHaveLength(2);
    const second = await adminListInventory({ q, page: 2, perPage: 2 });
    expect(second.rows).toHaveLength(2);
    const third = await adminListInventory({ q, page: 3, perPage: 2 });
    expect(third.rows).toHaveLength(2);
    const seen = new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.productId));
    expect(seen.size).toBe(6);
    expect(ids.every((id) => seen.has(id))).toBe(true);
  });

  it("adminListInventory filter=out returns only out-of-stock rows", async () => {
    const out = await seedProduct(0, { name: "Out Watch" });
    const stocked = await seedProduct(9, { name: "Stocked Watch" });
    const { rows } = await adminListInventory({ filter: "out" });
    expect(rows.some((r) => r.productId === out.id)).toBe(true);
    expect(rows.some((r) => r.productId === stocked.id)).toBe(false);
    expect(rows.every((r) => r.isOut)).toBe(true);
  });

  // Stage 2 audit (R1): the list is paginated in the database, one row per
  // Inventory row — a page boundary may split one product's rows, and
  // total counts rows, not products. The old in-memory slice fetched
  // every product to serve any page.
  it("adminListInventory counts inventory rows and a page can split one product's rows", async () => {
    const prefix = "SplitRows " + randomUUID();
    const product = await seedProduct(3, { name: `${prefix} Tee` });
    // Two variants => three stock rows for one product.
    for (let i = 0; i < 2; i++) {
      const variant = await db.productVariant.create({
        data: { productId: product.id, label: `Size ${i}`, sku: `SPLIT-${randomUUID()}`, sortOrder: i },
      });
      await db.inventory.create({
        data: { productId: product.id, variantId: variant.id, quantity: 1 + i, lowStockThreshold: 5 },
      });
    }
    const first = await adminListInventory({ q: prefix, page: 1, perPage: 2 });
    expect(first.total).toBe(3);
    expect(first.pages).toBe(2);
    expect(first.rows).toHaveLength(2);
    const second = await adminListInventory({ q: prefix, page: 2, perPage: 2 });
    expect(second.rows).toHaveLength(1);
    const keys = new Set(
      [...first.rows, ...second.rows].map((r) => `${r.productId}|${r.variantId ?? "null"}`),
    );
    expect(keys.size).toBe(3);
    expect([...keys].every((k) => k.startsWith(product.id))).toBe(true);
  });

  it("adminListInventory filter=low reports the exact filtered total", async () => {
    const prefix = "LowTotal " + randomUUID();
    const low = await seedProduct(2, { name: `${prefix} Low`, threshold: 5 });
    const stocked = await seedProduct(9, { name: `${prefix} Stocked`, threshold: 5 });
    const result = await adminListInventory({ q: prefix, filter: "low" });
    expect(result.total).toBe(1);
    expect(result.pages).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].productId).toBe(low.id);
    expect(result.rows.every((r) => r.isLow)).toBe(true);
    expect(result.rows.some((r) => r.productId === stocked.id)).toBe(false);
  });

  it("adminListInventory treats LIKE wildcards in q literally", async () => {
    const literal = await seedProduct(4, { name: "Pct% Literal " + randomUUID() });
    const other = await seedProduct(4, { name: "PctX Other " + randomUUID() });
    const result = await adminListInventory({ q: "Pct%" });
    const ids = new Set(result.rows.map((r) => r.productId));
    expect(ids.has(literal.id)).toBe(true);
    // An unescaped % would match every name containing "Pct" — including
    // the PctX product. The escape must keep it literal.
    expect(ids.has(other.id)).toBe(false);
  });

  it("getLowStockProducts totals variant stock before comparing to the threshold", async () => {
    const prefix = "VariantTotal " + randomUUID();
    // Total 2 + 2 = 4 <= 5: low, and the reported quantity is the total.
    const low = await seedProduct(2, { name: `${prefix} Low`, threshold: 5 });
    const lowVariant = await db.productVariant.create({
      data: { productId: low.id, label: "Large", sku: `VT-${randomUUID()}`, sortOrder: 0 },
    });
    await db.inventory.create({
      data: { productId: low.id, variantId: lowVariant.id, quantity: 2, lowStockThreshold: 5 },
    });
    // Total 6 + 0 = 6 > 5: not low, even though the variant row is empty.
    const notLow = await seedProduct(6, { name: `${prefix} Stocked`, threshold: 5 });
    const stockedVariant = await db.productVariant.create({
      data: { productId: notLow.id, label: "Large", sku: `VT-${randomUUID()}`, sortOrder: 0 },
    });
    await db.inventory.create({
      data: { productId: notLow.id, variantId: stockedVariant.id, quantity: 0, lowStockThreshold: 5 },
    });
    const all = await getLowStockProducts(5000);
    const mine = new Map(all.filter((r) => [low.id, notLow.id].includes(r.productId)).map((r) => [r.productId, r]));
    expect(mine.get(low.id)?.quantity).toBe(4);
    expect(mine.has(notLow.id)).toBe(false);
  });
});

describe("M-6 (Stage 3 audit) — adminUpdateInventory missing product/variant", () => {
  it("returns NOT_FOUND for a nonexistent product instead of an FK 500", async () => {
    const bogusId = randomUUID();
    const result = await adminUpdateInventory({ productId: bogusId, quantity: 5 });
    expect(result).toEqual({ ok: false, error: "Product not found", code: "NOT_FOUND" });
    // No inventory row was created for the bogus product.
    expect(await db.inventory.findFirst({ where: { productId: bogusId } })).toBeNull();
  });

  it("returns VARIANT_NOT_FOUND for a variant that does not belong to the product", async () => {
    const product = await seedProduct(5);
    const other = await seedProduct(5);
    const otherVariant = await db.productVariant.create({
      data: { productId: other.id, label: "Large", sku: `M6-${randomUUID()}`, sortOrder: 0 },
    });
    // Variant of another product: 404, never a cross-product write.
    expect(await adminUpdateInventory({ productId: product.id, variantId: otherVariant.id, quantity: 5 })).toEqual({
      ok: false, error: "Variant not found", code: "VARIANT_NOT_FOUND",
    });
    // Nonexistent variant id: 404 as well.
    expect(await adminUpdateInventory({ productId: product.id, variantId: randomUUID(), quantity: 5 })).toEqual({
      ok: false, error: "Variant not found", code: "VARIANT_NOT_FOUND",
    });
    // The product's own stock is untouched by both attempts.
    expect((await db.inventory.findFirstOrThrow({ where: { productId: product.id, variantId: null } })).quantity).toBe(5);
  });
});
