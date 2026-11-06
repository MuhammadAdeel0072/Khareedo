// Order history (FR-26).
import Link from "next/link";
import { redirect } from "next/navigation";
import { PackageOpen } from "lucide-react";
import { getUserOrders } from "@/services/orders.service";
import { getSessionUser } from "@/lib/auth-guard";
import { formatPKR, formatDate } from "@/lib/utils";
import { STATUS_BADGE_CLASSES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { withPerformanceTiming } from "@/lib/performance-timing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order History" };

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return withPerformanceTiming("page.orders-history", async () => {
  const user = await getSessionUser();
  if (!user) redirect("/login?callbackUrl=/account/orders");
  const params = await searchParams;
  const page = Number(Array.isArray(params.page) ? params.page[0] : params.page ?? "1") || 1;
  const orders = await getUserOrders(user.id, page, 10);

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight">My Orders</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Track and review your purchases</p>

      {orders.items.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <PackageOpen className="mx-auto h-12 w-12 text-muted-foreground/40" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-bold">No orders yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">When you place an order it will appear here.</p>
          <Button asChild className="mt-4">
            <Link href="/products">Start Shopping</Link>
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {orders.items.map((o) => (
              <Link
                key={o.id}
                href={`/account/orders/${o.id}`}
                className="block rounded-xl border p-4 transition-all hover:-translate-y-0.5 hover:shadow-md"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm font-bold">{o.reference}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(o.createdAt)} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"} ·{" "}
                      {o.paymentMethod === "COD" ? "Cash on Delivery" : o.paymentMethod}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={STATUS_BADGE_CLASSES[o.status] ?? ""}>
                      {o.status}
                    </Badge>
                    <span className="text-base font-extrabold text-primary">{formatPKR(o.total)}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {orders.pages > 1 && (
            <div className="mt-6 flex justify-center gap-2">
              {Array.from({ length: orders.pages }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={`/account/orders?page=${p}`}
                  className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm font-medium ${
                    p === orders.page
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  }`}
                  aria-current={p === orders.page ? "page" : undefined}
                >
                  {p}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
    );
  });
}
