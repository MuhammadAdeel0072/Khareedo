// Reports service — real database aggregates only, no fabricated metrics
// (FR-45, admin dashboard + reports page).
import { cache } from "react";
import { db } from "@/lib/db";

export interface DashboardStats {
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  /** Paid revenue only (D18): paymentStatus PAID and not cancelled. */
  totalRevenue: number;
  /** Unpaid order totals (D18): paymentStatus PENDING and not cancelled —
   * shown separately, never included in the paid revenue above. */
  pendingRevenue: number;
  lowStockCount: number;
  revenueThisMonth: number;
  pendingRevenueThisMonth: number;
  ordersThisMonth: number;
  ordersLastMonth: number;
}

export const getPendingOrdersCount = cache(() =>
  db.order.count({ where: { status: "PENDING" } })
);

export async function getDashboardStats(): Promise<DashboardStats> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [row] = await db.$queryRaw<Array<{
    totalOrders: bigint;
    totalCustomers: bigint;
    totalProducts: bigint;
    totalRevenue: bigint;
    pendingRevenue: bigint;
    lowStockCount: bigint;
    revenueThisMonth: bigint;
    pendingRevenueThisMonth: bigint;
    ordersThisMonth: bigint;
    ordersLastMonth: bigint;
  }>>`
    SELECT
      (SELECT COUNT(*) FROM "Order" WHERE "status" <> 'CANCELLED') AS "totalOrders",
      (SELECT COUNT(*) FROM "User" WHERE "role" = 'CUSTOMER') AS "totalCustomers",
      (SELECT COUNT(*) FROM "Product" WHERE "deletedAt" IS NULL) AS "totalProducts",
      -- Paid revenue only (D18/M-33): a cancelled order never counts, and
      -- neither does an unpaid one — even when its payment is merely PENDING
      -- (a cancelled paid order keeps payment PAID until refunded, but the
      -- sale itself is cancelled, so it is excluded here too).
      (SELECT COALESCE(SUM("total"), 0) FROM "Order" WHERE "status" <> 'CANCELLED' AND "paymentStatus" = 'PAID') AS "totalRevenue",
      (SELECT COALESCE(SUM("total"), 0) FROM "Order" WHERE "status" <> 'CANCELLED' AND "paymentStatus" = 'PENDING') AS "pendingRevenue",
      (SELECT COUNT(*) FROM "Inventory" WHERE "quantity" <= 5) AS "lowStockCount",
      (SELECT COALESCE(SUM("total"), 0) FROM "Order"
        WHERE "status" <> 'CANCELLED' AND "paymentStatus" = 'PAID' AND "createdAt" >= ${monthStart}) AS "revenueThisMonth",
      (SELECT COALESCE(SUM("total"), 0) FROM "Order"
        WHERE "status" <> 'CANCELLED' AND "paymentStatus" = 'PENDING' AND "createdAt" >= ${monthStart}) AS "pendingRevenueThisMonth",
      (SELECT COUNT(*) FROM "Order" WHERE "createdAt" >= ${monthStart}) AS "ordersThisMonth",
      (SELECT COUNT(*) FROM "Order"
        WHERE "createdAt" >= ${lastMonthStart} AND "createdAt" < ${monthStart}) AS "ordersLastMonth"
  `;

  return {
    totalOrders: Number(row.totalOrders),
    totalCustomers: Number(row.totalCustomers),
    totalProducts: Number(row.totalProducts),
    totalRevenue: Number(row.totalRevenue),
    pendingRevenue: Number(row.pendingRevenue),
    lowStockCount: Number(row.lowStockCount),
    revenueThisMonth: Number(row.revenueThisMonth),
    pendingRevenueThisMonth: Number(row.pendingRevenueThisMonth),
    ordersThisMonth: Number(row.ordersThisMonth),
    ordersLastMonth: Number(row.ordersLastMonth),
  };
}

/** Order counts per status for the dashboard donut. */
export async function getOrderStatusCounts() {
  const rows = await db.order.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  return rows.map((r) => ({ status: r.status, count: r._count._all }));
}

/** Revenue per day for the last N days (sales overview line chart) — paid
 * orders only (D18/M-33). */
export async function getRevenueByDay(days = 30) {
  // Window = the last `days` calendar days INCLUDING today: since is
  // today minus (days - 1) days, so the SQL totals and the day map cover
  // exactly the same dates. (The old code started at today - days and
  // built the map forward only `days` entries, so today's revenue was
  // silently dropped from the chart and the reports summary.)
  // The window is built in UTC, not local time: the day keys the SQL
  // returns are UTC calendar dates on both engines (Postgres renders the
  // timestamptz in the DB session timezone, UTC by default on Supabase;
  // SQLite keys are normalised to UTC dates below), while toISOString()
  // is also UTC. Building `since` from a LOCAL midnight shifts every map
  // key by the timezone offset — in PKT (UTC+5) the map's last key was
  // yesterday, so today's paid revenue never matched a key and the chart
  // (and getReportSummary's totalRevenue, which sums it) read 0.
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  const totals = await db.$queryRaw<Array<{ date: string; total: bigint | number }>>`
    SELECT SUBSTR(CAST("createdAt" AS TEXT), 1, 10) AS "date", SUM("total") AS "total"
    FROM "Order"
    WHERE "createdAt" >= ${since} AND "status" <> 'CANCELLED' AND "paymentStatus" = 'PAID'
    GROUP BY SUBSTR(CAST("createdAt" AS TEXT), 1, 10)
  `;
  const byDay = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setUTCDate(since.getUTCDate() + i);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of totals) {
    // The SQL groups by the first 10 chars of CAST(createdAt AS TEXT).
    // On Postgres createdAt is a timestamptz, so that is "YYYY-MM-DD".
    // On SQLite Prisma stores DateTime as integer epoch milliseconds, so
    // the cast yields "1795158701…" and the first 10 chars are epoch
    // SECONDS — convert those back to a UTC date, otherwise the day never
    // matches a map key and the chart silently drops every row.
    const key = /^\d{10}$/.test(row.date)
      ? new Date(Number(row.date) * 1000).toISOString().slice(0, 10)
      : row.date;
    if (byDay.has(key)) byDay.set(key, Number(row.total));
  }
  return Array.from(byDay.entries()).map(([date, total]) => ({ date, total }));
}

/** Unpaid order total for the last N days (D18/M-33): the pending
 * counterpart of the paid revenue total. Never counted as revenue. */
export async function getPendingRevenue(days = 30) {
  // Same window as getRevenueByDay: the last `days` calendar days
  // including today, in UTC so it matches the chart's window exactly.
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  const [row] = await db.$queryRaw<Array<{ total: bigint | number }>>`
    SELECT COALESCE(SUM("total"), 0) AS "total"
    FROM "Order"
    WHERE "createdAt" >= ${since} AND "status" <> 'CANCELLED' AND "paymentStatus" = 'PENDING'
  `;
  return Number(row.total);
}

/** Top selling products by units sold from order items (real data). */
export async function getTopSellingProducts(limit = 5) {
  const rows = await db.orderItem.groupBy({
    by: ["productName", "productSlug"],
    _sum: { quantity: true, lineTotal: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });
  return rows.map((r) => ({
    name: r.productName,
    slug: r.productSlug,
    unitsSold: r._sum.quantity ?? 0,
    revenue: r._sum.lineTotal ?? 0,
  }));
}

/** Recent orders for the dashboard table. */
export async function getRecentOrders(limit = 6) {
  const rows = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      reference: true,
      customerName: true,
      total: true,
      status: true,
      createdAt: true,
      _count: { select: { items: true } },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    reference: o.reference,
    customerName: o.customerName,
    itemCount: o._count.items,
    total: o.total,
    status: o.status,
    createdAt: o.createdAt,
  }));
}

/** Newest registered customers. */
export async function getRecentCustomers(limit = 5) {
  const rows = await db.user.findMany({
    where: { role: "CUSTOMER" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { _count: { select: { orders: true } } },
  });
  return rows.map((u) => ({
    id: u.id,
    name: u.name ?? u.email,
    email: u.email,
    createdAt: u.createdAt,
    orderCount: u._count.orders,
  }));
}

/** Reports page aggregates. totalRevenue is paid-only (D18/M-33);
 * pendingRevenue is the unpaid total over the same 30-day window, shown
 * separately. paidOrders is the count of paid orders in that window — the
 * denominator for the average order value, so AOV is the average *paid*
 * order, not paid revenue divided by every order including unpaid and
 * cancelled ones. */
export async function getReportSummary() {
  const days = 30;
  // Same window as getRevenueByDay/getPendingRevenue: the last 30 calendar
  // days including today, in UTC, so paidOrders counts the same orders whose
  // revenue is summed in totalRevenue.
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  since.setUTCHours(0, 0, 0, 0);
  const [byStatus, topProducts, revenueByDay, pendingRevenue, paidOrders] = await Promise.all([
    getOrderStatusCounts(),
    getTopSellingProducts(8),
    getRevenueByDay(days),
    getPendingRevenue(days),
    db.order.count({
      where: { paymentStatus: "PAID", status: { not: "CANCELLED" }, createdAt: { gte: since } },
    }),
  ]);
  const totalRevenue = revenueByDay.reduce((s, r) => s + r.total, 0);
  const totalOrders = byStatus.reduce((s, r) => s + r.count, 0);
  return { byStatus, topProducts, revenueByDay, totalRevenue, totalOrders, pendingRevenue, paidOrders };
}
