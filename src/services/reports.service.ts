// Reports service — real database aggregates only, no fabricated metrics
// (FR-45, admin dashboard + reports page).
import { cache } from "react";
import { db } from "@/lib/db";

export interface DashboardStats {
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  totalRevenue: number;
  lowStockCount: number;
  revenueThisMonth: number;
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
    lowStockCount: bigint;
    revenueThisMonth: bigint;
    ordersThisMonth: bigint;
    ordersLastMonth: bigint;
  }>>`
    SELECT
      (SELECT COUNT(*) FROM "Order" WHERE "status" <> 'CANCELLED') AS "totalOrders",
      (SELECT COUNT(*) FROM "User" WHERE "role" = 'CUSTOMER') AS "totalCustomers",
      (SELECT COUNT(*) FROM "Product" WHERE "deletedAt" IS NULL) AS "totalProducts",
      (SELECT COALESCE(SUM("total"), 0) FROM "Order" WHERE "status" <> 'CANCELLED') AS "totalRevenue",
      (SELECT COUNT(*) FROM "Inventory" WHERE "quantity" <= 5) AS "lowStockCount",
      (SELECT COALESCE(SUM("total"), 0) FROM "Order"
        WHERE "status" <> 'CANCELLED' AND "createdAt" >= ${monthStart}) AS "revenueThisMonth",
      (SELECT COUNT(*) FROM "Order" WHERE "createdAt" >= ${monthStart}) AS "ordersThisMonth",
      (SELECT COUNT(*) FROM "Order"
        WHERE "createdAt" >= ${lastMonthStart} AND "createdAt" < ${monthStart}) AS "ordersLastMonth"
  `;

  return {
    totalOrders: Number(row.totalOrders),
    totalCustomers: Number(row.totalCustomers),
    totalProducts: Number(row.totalProducts),
    totalRevenue: Number(row.totalRevenue),
    lowStockCount: Number(row.lowStockCount),
    revenueThisMonth: Number(row.revenueThisMonth),
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

/** Revenue per day for the last N days (sales overview line chart). */
export async function getRevenueByDay(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);
  const totals = await db.$queryRaw<Array<{ date: string; total: bigint | number }>>`
    SELECT SUBSTR(CAST("createdAt" AS TEXT), 1, 10) AS "date", SUM("total") AS "total"
    FROM "Order"
    WHERE "createdAt" >= ${since} AND "status" <> 'CANCELLED'
    GROUP BY SUBSTR(CAST("createdAt" AS TEXT), 1, 10)
  `;
  const byDay = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of totals) {
    if (byDay.has(row.date)) byDay.set(row.date, Number(row.total));
  }
  return Array.from(byDay.entries()).map(([date, total]) => ({ date, total }));
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

/** Reports page aggregates. */
export async function getReportSummary() {
  const [byStatus, topProducts, revenueByDay] = await Promise.all([
    getOrderStatusCounts(),
    getTopSellingProducts(8),
    getRevenueByDay(30),
  ]);
  const totalRevenue = revenueByDay.reduce((s, r) => s + r.total, 0);
  const totalOrders = byStatus.reduce((s, r) => s + r.count, 0);
  return { byStatus, topProducts, revenueByDay, totalRevenue, totalOrders };
}
