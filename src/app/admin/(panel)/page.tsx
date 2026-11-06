// Admin dashboard — overview with real DB data (FR-45).
import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  ArrowUpRight,
  DollarSign,
  Package,
  ShoppingCart,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { STATUS_BADGE_CLASSES } from "@/lib/constants";
import { formatPKR, formatDate, initials } from "@/lib/utils";
import {
  getDashboardStats,
  getOrderStatusCounts,
  getRecentOrders,
  getRecentCustomers,
  getRevenueByDay,
  getTopSellingProducts,
  getPendingOrdersCount,
} from "@/services/reports.service";
import { getLowStockProducts } from "@/services/inventory.service";
import { RevenueChart, StatusDonut } from "@/components/admin/dashboard-charts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin Dashboard" };

export default async function AdminDashboardPage() {
  const [stats, statusCounts, revenueByDay, recentOrders, topProducts, lowStock, newCustomers, pendingOrders] =
    await Promise.all([
      getDashboardStats(),
      getOrderStatusCounts(),
      getRevenueByDay(30),
      getRecentOrders(6),
      getTopSellingProducts(5),
      getLowStockProducts(4),
      getRecentCustomers(4),
      getPendingOrdersCount(),
    ]);

  const statusColors: Record<string, string> = {
    DELIVERED: "var(--chart-1)",
    PROCESSING: "var(--chart-3)",
    SHIPPED: "var(--chart-2)",
    PENDING: "var(--chart-4)",
    CONFIRMED: "oklch(0.7 0.1 180)",
    CANCELLED: "var(--chart-5)",
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Welcome back! Here&apos;s what&apos;s happening with your store.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 [&>*]:min-w-0 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<ShoppingCart className="h-5 w-5" />}
          tint="bg-brand-50 text-primary"
          label="Total Orders"
          value={stats.totalOrders.toLocaleString()}
          sub={`${stats.ordersThisMonth} this month`}
        />
        <StatCard
          icon={<Users className="h-5 w-5" />}
          tint="bg-sky-50 text-sky-600"
          label="Total Customers"
          value={stats.totalCustomers.toLocaleString()}
          sub="registered accounts"
        />
        <StatCard
          icon={<Package className="h-5 w-5" />}
          tint="bg-amber-50 text-amber-600"
          label="Total Products"
          value={stats.totalProducts.toLocaleString()}
          sub={`${stats.lowStockCount} low in stock`}
        />
        <StatCard
          icon={<DollarSign className="h-5 w-5" />}
          tint="bg-emerald-50 text-emerald-600"
          label="Total Revenue"
          value={formatPKR(stats.totalRevenue)}
          sub={`${formatPKR(stats.revenueThisMonth)} this month`}
        />
      </div>

      {/* Charts */}
      <div className="mt-4 grid gap-4 [&>*]:min-w-0 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Sales Overview</CardTitle>
            <CardDescription>Revenue for the last 30 days (excludes cancelled)</CardDescription>
          </CardHeader>
          <CardContent>
            <RevenueChart data={revenueByDay} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Order Status</CardTitle>
            <CardDescription>Current distribution</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusDonut
              data={statusCounts.map((s) => ({
                name: s.status,
                value: s.count,
                color: statusColors[s.status] ?? "var(--chart-1)",
              }))}
            />
          </CardContent>
        </Card>
      </div>

      {/* Middle row */}
      <div className="mt-4 grid gap-4 [&>*]:min-w-0 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Recent Orders</CardTitle>
              <CardDescription>Latest orders received</CardDescription>
            </div>
            <Link href="/admin/orders" className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              View All <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No orders yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 pr-3 font-semibold">Order</th>
                      <th className="pb-2 pr-3 font-semibold">Customer</th>
                      <th className="pb-2 pr-3 font-semibold">Items</th>
                      <th className="pb-2 pr-3 font-semibold">Amount</th>
                      <th className="pb-2 pr-3 font-semibold">Status</th>
                      <th className="pb-2 font-semibold">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {recentOrders.map((o) => (
                      <tr key={o.id} className="hover:bg-muted/50">
                        <td className="py-2.5 pr-3">
                          <Link href={`/admin/orders/${o.id}`} className="font-mono text-xs font-bold text-primary hover:underline">
                            {o.reference}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-3">{o.customerName}</td>
                        <td className="py-2.5 pr-3 text-muted-foreground">{o.itemCount}</td>
                        <td className="py-2.5 pr-3 font-semibold">{formatPKR(o.total)}</td>
                        <td className="py-2.5 pr-3">
                          <Badge variant="outline" className={STATUS_BADGE_CLASSES[o.status] ?? ""}>
                            {o.status}
                          </Badge>
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground">{formatDate(o.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Top Selling Products</CardTitle>
              <CardDescription>By units sold</CardDescription>
            </div>
            <Link href="/admin/reports" className="text-xs font-semibold text-primary hover:underline">
              Reports
            </Link>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No sales data yet.</p>
            ) : (
              <ol className="space-y-3">
                {topProducts.map((p, i) => (
                  <li key={p.slug ?? p.name} className="flex items-center gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-primary">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.unitsSold} sold</p>
                    </div>
                    <span className="text-sm font-bold">{formatPKR(p.revenue)}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="mt-4 grid gap-4 [&>*]:min-w-0 xl:grid-cols-3">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Low Stock Products</CardTitle>
            <Link href="/admin/inventory" className="text-xs font-semibold text-primary hover:underline">
              Manage
            </Link>
          </CardHeader>
          <CardContent>
            {lowStock.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">All products are well stocked ✓</p>
            ) : (
              <ul className="space-y-3">
                {lowStock.map((p) => (
                  <li key={p.productId} className="flex items-center gap-3">
                    <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <Image src={p.image ?? "/images/placeholder.svg"} alt="" fill sizes="40px" className="object-cover" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="text-xs font-semibold text-red-600">
                        {p.quantity === 0 ? "Out of stock" : `Only ${p.quantity} left`}
                      </p>
                    </div>
                    <span className="text-sm font-semibold">{formatPKR(p.price)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">New Customers</CardTitle>
            <Link href="/admin/customers" className="text-xs font-semibold text-primary hover:underline">
              View All
            </Link>
          </CardHeader>
          <CardContent>
            {newCustomers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No registered customers yet.</p>
            ) : (
              <ul className="space-y-3">
                {newCustomers.map((c) => (
                  <li key={c.id} className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="bg-primary text-xs font-bold text-primary-foreground">
                        {initials(c.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{c.orderCount} orders</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" aria-hidden="true" /> This Month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="flex items-baseline gap-1 text-2xl font-extrabold">
                {stats.ordersThisMonth}
                <span className="text-xs font-medium text-muted-foreground">orders</span>
                {stats.ordersLastMonth > 0 && (
                  <span className="ml-1 flex items-center gap-0.5 text-xs font-bold text-emerald-600">
                    <ArrowUpRight className="h-3 w-3" />
                    {Math.round(((stats.ordersThisMonth - stats.ordersLastMonth) / stats.ordersLastMonth) * 100)}%
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">vs {stats.ordersLastMonth} last month</p>
            </div>
            <div>
              <p className="text-2xl font-extrabold">{formatPKR(stats.revenueThisMonth)}</p>
              <p className="text-xs text-muted-foreground">revenue this month</p>
            </div>
            <div>
              <p className="text-sm font-bold text-amber-600">{pendingOrders} pending</p>
              <p className="text-xs text-muted-foreground">orders awaiting confirmation</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  tint,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  tint: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${tint}`} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-extrabold">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}
