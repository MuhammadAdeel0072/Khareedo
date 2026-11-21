// Inventory service — stock visibility & authorized updates (FR-40, FR-45, BR-14).
import { db } from "@/lib/db";
import { inventoryUpdateSchema } from "@/lib/validation";
import { getPrismaErrorCode } from "@/lib/api";
import { ADMIN_PAGE_SIZE } from "@/lib/constants";
import { ReservationWriteConflict, writeAvailableStock } from "@/services/reservation-writes";

export interface InventoryRow {
  productId: string;
  /** Null = the product-level stock row; set = that variant's row. */
  variantId: string | null;
  variantLabel: string | null;
  productName: string;
  category: string;
  quantity: number;
  /** Units locked by HELD payment reservations (M-8c): shown alongside the
   * available quantity so 0 available + 5 held does not look identical to
   * genuinely out-of-stock. */
  heldQuantity: number;
  lowStockThreshold: number;
  isLow: boolean;
  isOut: boolean;
  status: string;
}

export interface AdminInventoryList {
  rows: InventoryRow[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}

/** Escape LIKE wildcards in a user search term so `%` / `_` / `\` in a
 * product name are matched literally, not as pattern syntax (the old
 * Prisma `contains` escaped them; raw SQL does not). */
function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

type AdminInventoryRawRow = {
  productId: string;
  variantId: string | null;
  variantLabel: string | null;
  productName: string;
  category: string;
  quantity: number | bigint;
  lowStockThreshold: number | bigint;
  heldQuantity: number | bigint;
  status: string;
};

/** Admin inventory list (FR-40, FR-45): paginated in the database (Stage 2
 * audit, R1). One raw query per page — the old implementation fetched
 * every non-deleted product with all inventory rows and reservations and
 * sliced in memory, so a large catalogue blew up Node memory and the
 * transfer on every page load. The row unit is one Inventory row (the
 * product-level row plus one per variant); a product with no inventory
 * row at all still yields one zero-quantity row via the LEFT JOIN, so it
 * stays visible and editable.
 *
 * Why raw SQL and not typed Prisma: the low/out filter compares two
 * columns of the same row (quantity vs that row's own lowStockThreshold),
 * which Prisma cannot express in a WHERE, and the page boundary can
 * split one product's rows, which a product-level `take` cannot express
 * without silently dropping rows (the old 200-row cap bug). The query
 * is one template per statement (rows + count) with bound parameters
 * only — no Prisma.sql fragment composition (see the bundler hazard
 * noted in products.service.ts) and no $queryRawUnsafe. It is verified
 * against both dialects the project runs: the disposable SQLite harness
 * (integration.inventory.test.ts) and disposable Postgres 16.4 with the
 * full migrated schema (see audit-stage2-fixes.md). LIKE keeps the old
 * case behaviour (case-sensitive on Postgres, ASCII-insensitive on
 * SQLite — the same as the old `contains`). Ordering is deterministic
 * (product createdAt DESC, product id DESC tiebreak, inventory id ASC)
 * so pages are stable and disjoint. */
export async function adminListInventory(input: {
  q?: string;
  filter?: string;
  page?: number;
  perPage?: number;
} = {}): Promise<AdminInventoryList> {
  const page = Math.max(1, Math.floor(input.page ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Math.floor(input.perPage ?? ADMIN_PAGE_SIZE) || ADMIN_PAGE_SIZE));
  const offset = (page - 1) * perPage;
  const trimmedQ = input.q?.trim() ?? "";
  const qPattern =
    trimmedQ !== "" ? `%${escapeLikePattern(trimmedQ)}%` : null;
  // Postgres cannot infer the type of a bare `$n IS NULL` parameter
  // (42P18) — the queries below therefore test CAST($n AS TEXT) IS NULL,
  // which is also valid on SQLite. Without the CAST every call fails on
  // Postgres, with or without a search term (Stage 5/6 regression find).
  // Exactly one of these is 1; both 0 = the unfiltered view.
  const lowOnly = input.filter === "low" ? 1 : 0;
  const outOnly = input.filter === "out" ? 1 : 0;

  // The WHERE clause below is duplicated in the count query — the two
  // must stay in sync (same predicate, same bound parameters), or
  // total/pages will disagree with the rows on the page. Rows and count
  // are independent, so they run in parallel (one batch, not two
  // sequential round trips).
  const [rows, counted] = await Promise.all([
    db.$queryRaw<AdminInventoryRawRow[]>`
    SELECT
      p."id" AS "productId",
      i."variantId" AS "variantId",
      v."label" AS "variantLabel",
      p."name" AS "productName",
      c."name" AS "category",
      COALESCE(i."quantity", 0) AS "quantity",
      COALESCE(i."lowStockThreshold", 5) AS "lowStockThreshold",
      COALESCE(SUM(r."quantity"), 0) AS "heldQuantity",
      p."status" AS "status"
    FROM "Product" AS p
    JOIN "Category" AS c ON c."id" = p."categoryId"
    LEFT JOIN "Inventory" AS i ON i."productId" = p."id"
    LEFT JOIN "ProductVariant" AS v ON v."id" = i."variantId"
    LEFT JOIN "InventoryReservation" AS r ON r."inventoryId" = i."id" AND r."state" = 'HELD'
    WHERE p."deletedAt" IS NULL
      AND (CAST(${qPattern} AS TEXT) IS NULL OR p."name" LIKE ${qPattern} ESCAPE '\\')
      AND (
        (${lowOnly} = 0 AND ${outOnly} = 0)
        OR (${lowOnly} = 1 AND COALESCE(i."quantity", 0) > 0 AND COALESCE(i."quantity", 0) <= COALESCE(i."lowStockThreshold", 5))
        OR (${outOnly} = 1 AND COALESCE(i."quantity", 0) <= 0)
      )
    GROUP BY p."id", p."name", p."status", p."createdAt", c."name", i."id", i."variantId", i."quantity", i."lowStockThreshold", v."label"
    ORDER BY p."createdAt" DESC, p."id" DESC, i."id" ASC
    LIMIT ${perPage} OFFSET ${offset}
  `,
    // Count of (product, inventory-row) groups under the same predicate.
    // The Category / variant / reservation joins cannot change the group
    // count (each is at most one row per group, and reservations only feed
    // the SUM), so the count runs over Product × Inventory alone.
    db.$queryRaw<Array<{ count: number | bigint }>>`
    SELECT COUNT(*) AS "count" FROM (
      SELECT 1
      FROM "Product" AS p
      LEFT JOIN "Inventory" AS i ON i."productId" = p."id"
      WHERE p."deletedAt" IS NULL
        AND (CAST(${qPattern} AS TEXT) IS NULL OR p."name" LIKE ${qPattern} ESCAPE '\\')
        AND (
          (${lowOnly} = 0 AND ${outOnly} = 0)
          OR (${lowOnly} = 1 AND COALESCE(i."quantity", 0) > 0 AND COALESCE(i."quantity", 0) <= COALESCE(i."lowStockThreshold", 5))
          OR (${outOnly} = 1 AND COALESCE(i."quantity", 0) <= 0)
        )
      GROUP BY p."id", i."id"
    ) AS "groups"
  `,
  ]);
  const total = Number(counted[0]?.count ?? 0);
  return {
    rows: rows.map((r) => {
      const quantity = Number(r.quantity);
      const threshold = Number(r.lowStockThreshold);
      return {
        productId: r.productId,
        variantId: r.variantId,
        variantLabel: r.variantLabel,
        productName: r.productName,
        category: r.category,
        quantity,
        heldQuantity: Number(r.heldQuantity),
        lowStockThreshold: threshold,
        isLow: quantity > 0 && quantity <= threshold,
        isOut: quantity <= 0,
        status: r.status,
      };
    }),
    total,
    page,
    perPage,
    pages: Math.ceil(total / perPage),
  };
}

type LowStockRawRow = {
  productId: string;
  name: string;
  price: number;
  quantity: number | bigint;
  threshold: number | bigint;
};

export async function getLowStockProducts(limit = 6) {
  // Fully DB-side now (Stage 2 audit, R1): the old implementation fetched
  // every published product whose rows passed a coarse max-threshold
  // pre-filter and compared totals in memory — unbounded input for a
  // 6-row widget. The exact rule (total stock across the product-level
  // row and every variant row, vs the product-level row's own threshold)
  // is a GROUP BY + HAVING, which Prisma cannot express (per-row column
  // comparison + cross-row sum in one predicate). Same raw-SQL discipline
  // as adminListInventory above: one bound-parameter template, no
  // fragment composition, verified on disposable SQLite (this file's
  // integration tests, incl. the 1,010-product no-panic test) and on
  // disposable Postgres 16.4 with the full migrated schema.
  //
  // Images are fetched in a second query for only the surviving rows, NOT
  // as `images: { take: 1, orderBy: { sortOrder: "asc" } }` on this
  // unbounded parent query: the Prisma query engine panics with
  // `PrismaClientRustPanicError: no entry found for key` (record.rs) when
  // that relation pattern runs over ~1,003+ parent rows — reproduced
  // against a disposable SQLite database with 1,050 published products
  // (passes at 1,002 parents, panics at 1,005). A store with more than
  // ~1,000 published products would crash the low-stock widget on every
  // call, so the parent query stays image-free and the image lookup stays
  // bounded to at most `limit` products.
  const take = Math.max(0, Math.floor(limit));
  const rawRows = await db.$queryRaw<LowStockRawRow[]>`
    SELECT
      p."id" AS "productId",
      p."name" AS "name",
      p."price" AS "price",
      COALESCE(SUM(i."quantity"), 0) AS "quantity",
      COALESCE(MAX(CASE WHEN i."variantId" IS NULL THEN i."lowStockThreshold" END), 5) AS "threshold"
    FROM "Product" AS p
    LEFT JOIN "Inventory" AS i ON i."productId" = p."id"
    WHERE p."status" = 'PUBLISHED' AND p."deletedAt" IS NULL
    GROUP BY p."id", p."name", p."price"
    HAVING COALESCE(SUM(i."quantity"), 0) <= COALESCE(MAX(CASE WHEN i."variantId" IS NULL THEN i."lowStockThreshold" END), 5)
    ORDER BY "quantity" ASC, p."id" ASC
    LIMIT ${take}
  `;
  // Lowest available quantity first, `limit` rows — the shape/ordering of
  // the result is unchanged from the old in-memory implementation.
  const low = rawRows.map((r) => ({
    productId: r.productId,
    name: r.name,
    image: null as string | null,
    quantity: Number(r.quantity),
    price: r.price,
    threshold: Number(r.threshold),
  }));
  if (low.length > 0) {
    // First image per product by sortOrder (id breaks ties deterministically
    // — the old in-query take had no tiebreak). Bounded to `limit` products.
    // The Prisma query engine panics ("no entry found for key") on a single
    // productImage query with a large `in` list, so fetch in small batches
    // (regression test below trips the unbatched form at ~2,000 ids).
    const firstImage = new Map<string, string>();
    const BATCH = 100;
    for (let i = 0; i < low.length; i += BATCH) {
      const batchIds = low.slice(i, i + BATCH).map((p) => p.productId);
      const images = await db.productImage.findMany({
        where: { productId: { in: batchIds } },
        orderBy: [{ productId: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
        select: { productId: true, url: true },
      });
      for (const image of images) {
        if (!firstImage.has(image.productId)) firstImage.set(image.productId, image.url);
      }
    }
    for (const p of low) p.image = firstImage.get(p.productId) ?? null;
  }
  return low.map(({ threshold: _threshold, ...rest }) => rest);
}

export type InventoryDriftReason = "ORDER_CLOSED" | "ORDER_SETTLED" | "QUANTITY_MISMATCH" | "EXPIRED";

export interface InventoryDriftItem {
  inventoryId: string;
  productId: string;
  productName: string;
  reservationId: string;
  orderId: string;
  orderReference: string;
  heldQuantity: number;
  orderItemQuantity: number;
  orderStatus: string;
  reasons: InventoryDriftReason[];
}

/**
 * Inventory↔reservation drift audit (M-18). A HELD reservation decrements
 * available stock at creation and must be CONSUMED on settlement or
 * RELEASED on close/expiry — nothing previously verified that. A held row
 * is drifted when its order no longer justifies holding stock: the order
 * is closed without a retained-for-review flag, the order settled (payment
 * captured) without the hold being consumed, the held quantity disagrees
 * with the order line, or the reservation expired while the checkout is
 * still open (the expiry sweep should have freed it). Holds retained for
 * payment review (`paymentReviewStatus: "REQUIRED"`) are legitimate and
 * are not drift. Read-only; it reports, it never mutates stock.
 */
export async function getInventoryReservationDrift(now = new Date()): Promise<{ count: number; items: InventoryDriftItem[] }> {
  const held = await db.inventoryReservation.findMany({
    where: { state: "HELD" },
    include: {
      inventory: { include: { product: { select: { id: true, name: true } } } },
      orderItem: {
        include: {
          order: {
            select: {
              id: true, reference: true, status: true, paymentStatus: true,
              paymentReviewStatus: true, reservationExpiresAt: true, checkoutClosedAt: true,
            },
          },
        },
      },
    },
    orderBy: { heldAt: "asc" },
  });
  const items: InventoryDriftItem[] = [];
  for (const hold of held) {
    const order = hold.orderItem.order;
    const reasons: InventoryDriftReason[] = [];
    const orderClosed = order.checkoutClosedAt !== null || order.status === "CANCELLED";
    if (orderClosed && order.paymentReviewStatus !== "REQUIRED") reasons.push("ORDER_CLOSED");
    else if (!orderClosed && (order.status !== "PENDING" || order.paymentStatus === "PAID")) reasons.push("ORDER_SETTLED");
    if (hold.quantity !== hold.orderItem.quantity) reasons.push("QUANTITY_MISMATCH");
    if (!orderClosed && order.status === "PENDING" && order.reservationExpiresAt !== null && order.reservationExpiresAt < now) reasons.push("EXPIRED");
    if (reasons.length === 0) continue;
    items.push({
      inventoryId: hold.inventoryId,
      productId: hold.inventory.product.id,
      productName: hold.inventory.product.name,
      reservationId: hold.id,
      orderId: order.id,
      orderReference: order.reference,
      heldQuantity: hold.quantity,
      orderItemQuantity: hold.orderItem.quantity,
      orderStatus: order.status,
      reasons,
    });
  }
  return { count: items.length, items };
}

/** Authorized stock update with validation (never negative, FR-40).
 *  `variantId` targets that variant's stock row; omitted (null) targets
 *  the product-level row (Chunk 8 — D12). */
export async function adminUpdateInventory(input: {
  productId: string;
  variantId?: string | null;
  quantity: number;
  lowStockThreshold?: number;
}) {
  const parsed = inventoryUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid stock value" };
  }
  const { productId, variantId, quantity, lowStockThreshold } = parsed.data;
  // Stage 3 audit, M-6: writeAvailableStock creates the inventory row
  // when none exists, so a bogus productId used to reach the insert and
  // violate the FK → Prisma error → handleRoute 500. Check first: a
  // missing product is a 404 (code NOT_FOUND), never a 500.
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) return { ok: false as const, error: "Product not found", code: "NOT_FOUND" as const };
  // A variantId must name a variant of THIS product — an update for a
  // variant of another product is a validation error, not a cross-product
  // write.
  if (variantId) {
    const variant = await db.productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true },
    });
    // Stage 3 audit, M-6: a missing variant is a 404 (code
    // VARIANT_NOT_FOUND), not the 422 the route used to return for every
    // service failure.
    if (!variant) return { ok: false as const, error: "Variant not found", code: "VARIANT_NOT_FOUND" as const };
  }
  try {
    await db.$transaction(tx => writeAvailableStock(tx, { productId, variantId: variantId ?? null, quantity, lowStockThreshold }));
  } catch (error) {
    if (error instanceof ReservationWriteConflict) return { ok: false as const, error: error.message };
    // Defensive: the product could be deleted between the check above
    // and the insert — an FK violation is the same missing product, not
    // a 500.
    if (getPrismaErrorCode(error) === "P2003") {
      return { ok: false as const, error: "Product not found", code: "NOT_FOUND" as const };
    }
    throw error;
  }
  return { ok: true as const };
}
