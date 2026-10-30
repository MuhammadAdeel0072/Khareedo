// Admin reports — real database aggregates (FR-45, no fabricated metrics).
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatPKR } from "@/lib/utils";
import { getReportSummary } from "@/services/reports.service";
import { getLowStockProducts } from "@/services/inventory.service";
import { ExportButtons } from "@/components/admin/export-buttons";
import { RevenueChart, StatusDonut } from "@/components/admin/dashboard-charts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports · Admin" };

const STATUS_COLORS: Record<string, string> = {
  DELIVERED: "var(--chart-1)",
  PROCESSING: "var(--chart-3)",
  SHIPPED: "var(--chart-2)",
  PENDING: "var(--chart-4)",
  CONFIRMED: "oklch(0.7 0.1 180)",
  CANCELLED: "var(--chart-5)",
};

export default async function AdminReportsPage() {
  const [summary, lowStock] = await Promise.all([
    getReportSummary(),
    getLowStockProducts(8),
  ]);

  const avgOrder = summary.totalOrders > 0 ? Math.round(summary.totalRevenue / summary.totalOrders) : 0;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational insights from real store data (last 30 days)
          </p>
        </div>
        <ExportButtons type="reports" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <MiniStat label="Revenue (30 days)" value={formatPKR(summary.totalRevenue)} />
        <MiniStat label="Orders (all time)" value={summary.totalOrders.toLocaleString()} />
        <MiniStat label="Average Order Value" value={formatPKR(avgOrder)} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Revenue Trend</CardTitle>
            <CardDescription>Daily revenue, last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <RevenueChart data={summary.revenueByDay} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Orders by Status</CardTitle>
            <CardDescription>All time</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusDonut
              data={summary.byStatus.map((s) => ({
                name: s.status,
                value: s.count,
                color: STATUS_COLORS[s.status] ?? "var(--chart-1)",
              }))}
            />
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Product Performance</CardTitle>
            <CardDescription>Top 8 products by units sold</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.topProducts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No sales data yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-semibold">#</th>
                    <th className="pb-2 font-semibold">Product</th>
                    <th className="pb-2 text-right font-semibold">Units</th>
                    <th className="pb-2 text-right font-semibold">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {summary.topProducts.map((p, i) => (
                    <tr key={`${p.slug}-${i}`}>
                      <td className="py-2.5 text-muted-foreground">{i + 1}</td>
                      <td className="py-2.5 font-medium">{p.name}</td>
                      <td className="py-2.5 text-right">{p.unitsSold}</td>
                      <td className="py-2.5 text-right font-semibold">{formatPKR(p.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inventory Status</CardTitle>
            <CardDescription>Products needing restock attention</CardDescription>
          </CardHeader>
          <CardContent>
            {lowStock.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">All products are well stocked ✓</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-semibold">Product</th>
                    <th className="pb-2 text-right font-semibold">Stock</th>
                    <th className="pb-2 text-right font-semibold">Price</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {lowStock.map((p) => (
                    <tr key={p.productId}>
                      <td className="py-2.5 font-medium">{p.name}</td>
                      <td className={`py-2.5 text-right font-bold ${p.quantity === 0 ? "text-red-600" : "text-amber-600"}`}>
                        {p.quantity}
                      </td>
                      <td className="py-2.5 text-right">{formatPKR(p.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-extrabold">{value}</p>
    </div>
  );
}
