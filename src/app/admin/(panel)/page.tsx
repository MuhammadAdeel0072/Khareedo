// Admin dashboard — overview with real DB data (FR-45).
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  AlertTriangle,
  Check,
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
import { getLowStockProducts, getInventoryReservationDrift } from "@/services/inventory.service";
import { listEmailOutboxEntries } from "@/services/email-outbox.service";
import { countPaymentReviewCases } from "@/services/payment-review.service";
import { getOutboxWorkerHeartbeat, getWorkerHeartbeat } from "@/services/worker-heartbeat";
import NextDynamic from "next/dynamic";
import { WorkerHealthRow } from "@/components/admin/worker-health-row";
// Batch 3 perf: the Recharts charts load as a separate chunk instead of in
// this page's initial bundle. Plain next/dynamic (ssr: true) — ssr: false is
// not allowed in Server Components, so the charts still render server-side,
// but their code is split from the page bundle. Imported as `NextDynamic`
// because this file already exports `dynamic = "force-dynamic"` (route
// segment config), which would collide with a `dynamic` import name.
const RevenueChart = NextDynamic(
  () => import("@/components/admin/dashboard-charts").then((m) => m.RevenueChart),
  {
    loading: () => <div aria-hidden="true" className="h-64 w-full animate-pulse rounded-lg bg-muted" />,
  },
);
const StatusDonut = NextDynamic(
  () => import("@/components/admin/dashboard-charts").then((m) => m.StatusDonut),
  {
    loading: () => <div aria-hidden="true" className="mx-auto h-44 w-44 animate-pulse rounded-full bg-muted" />,
  },
);
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ProductImage } from "@/components/products/product-image";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin Dashboard" };

export default async function AdminDashboardPage() {
  const [stats, statusCounts, revenueByDay, recentOrders, topProducts, lowStock, newCustomers, pendingOrders, failedEmails, reviewRequired, drift, worker, outboxWorker] =
    await Promise.all([
      getDashboardStats(),
      getOrderStatusCounts(),
      getRevenueByDay(30),
      getRecentOrders(6),
      getTopSellingProducts(5),
      getLowStockProducts(4),
      getRecentCustomers(4),
      getPendingOrdersCount(),
      // Ops health (M-32): counts come from the same service functions the
      // detail pages use — outbox viewer, review queue, inventory drift —
      // so the numbers here can never disagree with those pages.
      listEmailOutboxEntries({ status: "FAILED", perPage: 1 }),
      countPaymentReviewCases(),
      getInventoryReservationDrift(),
      // D15: the payment maintenance worker heartbeat. The queue counts
      // above cannot prove the worker is alive — a dead worker leaves
      // rows PENDING and reservations unexpired, so all three counts can
      // read zero while nothing is running.
      getWorkerHeartbeat(),
      // Stream F: the email outbox worker heartbeat. Same reasoning — a
      // dead outbox worker leaves rows PENDING (not FAILED), so the
      // failed-email count above can read zero while no email delivers.
      getOutboxWorkerHeartbeat(),
    ]);
  const failedEmailCount = failedEmails.total;
  const expiredHoldCount = drift.items.filter((i) => i.reasons.includes("EXPIRED")).length;

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
          tint="bg-brand-50 text-primary"
          label="Total Customers"
          value={stats.totalCustomers.toLocaleString()}
          sub="registered accounts"
        />
        <StatCard
          icon={<Package className="h-5 w-5" />}
          tint="bg-warning/10 text-warning"
          label="Total Products"
          value={stats.totalProducts.toLocaleString()}
          sub={`${stats.lowStockCount} low in stock`}
        />
        <StatCard
          icon={<DollarSign className="h-5 w-5" />}
          tint="bg-brand-50 text-primary"
          label="Total Revenue"
          value={formatPKR(stats.totalRevenue)}
          sub={`${formatPKR(stats.revenueThisMonth)} paid this month · ${formatPKR(stats.pendingRevenue)} pending`}
        />
      </div>

      {/* Operations health (M-32): the three queues that used to be visible
          only in error logs — failed emails, payments awaiting review, and
          expired reservations still holding stock. Each count links to the
          page that resolves it. Holds are never released from here: release
          and consume stay manual actions in payment review, by design. */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" /> Operations health
          </CardTitle>
          <CardDescription>Things waiting on a human — failed deliveries, reviews, stuck holds</CardDescription>
        </CardHeader>
        <CardContent>
          {failedEmailCount === 0 && reviewRequired === 0 && expiredHoldCount === 0 && worker.status === "healthy" && outboxWorker.status === "healthy" ? (
            <p className="flex items-center gap-1.5 py-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-primary" aria-hidden="true" /> All clear — nothing needs attention.
            </p>
          ) : (
            <ul className="divide-y">
              <WorkerHealthRow worker={worker} outboxWorker={outboxWorker} />
              <li className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <p className="text-sm">
                  <span className={`font-bold ${failedEmailCount > 0 ? "text-destructive" : ""}`}>{failedEmailCount}</span>
                  {" "}failed email{failedEmailCount === 1 ? "" : "s"} in the outbox
                </p>
                <Link href="/admin/email-outbox?status=FAILED" className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                  View outbox <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <p className="text-sm">
                  <span className={`font-bold ${reviewRequired > 0 ? "text-destructive" : ""}`}>{reviewRequired}</span>
                  {" "}payment{reviewRequired === 1 ? "" : "s"} needing review
                </p>
                <Link href="/admin/payments/review" className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                  Review queue <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <p className="text-sm">
                  <span className={`font-bold ${expiredHoldCount > 0 ? "text-destructive" : ""}`}>{expiredHoldCount}</span>
                  {" "}expired reservation{expiredHoldCount === 1 ? "" : "s"} still holding stock
                </p>
                <Link href="/admin/inventory" className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                  View inventory <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              </li>
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="mt-4 grid gap-4 [&>*]:min-w-0 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Sales Overview</CardTitle>
            <CardDescription>Paid revenue for the last 30 days (excludes cancelled and unpaid)</CardDescription>
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
              <p className="flex items-center justify-center gap-1.5 py-6 text-center text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-primary" aria-hidden="true" /> All products are well stocked
              </p>
            ) : (
              <ul className="space-y-3">
                {lowStock.map((p) => (
                  <li key={p.productId} className="flex items-center gap-3">
                    <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <ProductImage src={p.image} alt="" fill sizes="40px" className="object-cover" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="text-xs font-semibold text-destructive">
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
                  <span className="ml-1 flex items-center gap-0.5 text-xs font-bold text-primary">
                    <ArrowUpRight className="h-3 w-3" />
                    {Math.round(((stats.ordersThisMonth - stats.ordersLastMonth) / stats.ordersLastMonth) * 100)}%
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">vs {stats.ordersLastMonth} last month</p>
            </div>
            <div>
              <p className="text-2xl font-extrabold">{formatPKR(stats.revenueThisMonth)}</p>
              <p className="text-xs text-muted-foreground">paid revenue this month</p>
            </div>
            <div>
              <p className="text-2xl font-extrabold">{formatPKR(stats.pendingRevenueThisMonth)}</p>
              <p className="text-xs text-muted-foreground">pending (unpaid) this month</p>
            </div>
            <div>
              <p className="text-sm font-bold text-warning">{pendingOrders} pending</p>
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
