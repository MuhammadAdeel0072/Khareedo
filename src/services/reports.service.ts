// Reports service — real database aggregates only, no fabricated metrics
// (FR-45, admin dashboard + reports page).
import { cache } from "react";
import { db } from "@/lib/db";

export interface DashboardStats {
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  totalRevenue: number;
  pendingOrders: number;
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

  const [
    totalOrders,
    totalCustomers,
    totalProducts,
    revenueAgg,
    pendingOrders,
    lowStockCount,
    revenueThisMonthAgg,
    ordersThisMonth,
    ordersLastMonth,
  ] = await Promise.all([
    db.order.count({ where: { status: { not: "CANCELLED" } } }),
    db.user.count({ where: { role: "CUSTOMER" } }),
    db.product.count({ where: { deletedAt: null } }),
    db.order.aggregate({
      where: { status: { not: "CANCELLED" } },
      _sum: { total: true },
    }),
    getPendingOrdersCount(),
    db.inventory.count({ where: { quantity: { lte: 5 } } }),
    db.order.aggregate({
      where: { status: { not: "CANCELLED" }, createdAt: { gte: monthStart } },
      _sum: { total: true },
    }),
    db.order.count({ where: { createdAt: { gte: monthStart } } }),
    db.order.count({
      where: { createdAt: { gte: lastMonthStart, lt: monthStart } },
    }),
  ]);

  return {
    totalOrders,
    totalCustomers,
    totalProducts,
    totalRevenue: revenueAgg._sum.total ?? 0,
    pendingOrders,
    lowStockCount,
    revenueThisMonth: revenueThisMonthAgg._sum.total ?? 0,
    ordersThisMonth,
    ordersLastMonth,
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
  const orders = await db.order.findMany({
    where: { createdAt: { gte: since }, status: { not: "CANCELLED" } },
    select: { total: true, createdAt: true },
  });
  const byDay = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const o of orders) {
    const key = o.createdAt.toISOString().slice(0, 10);
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + o.total);
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
    include: { items: { select: { id: true } } },
  });
  return rows.map((o) => ({
    id: o.id,
    reference: o.reference,
    customerName: o.customerName,
    itemCount: o.items.length,
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
