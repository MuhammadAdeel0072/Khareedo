// Admin orders list (FR-41).
// URL is the single source of truth: q (search), status and page all live in
// the query string, so refresh / Back / Forward stay perfectly consistent.
// "All" clears the search AND the status filter AND pagination (HCI: an
// explicit reset affordance), while status tabs deliberately combine with an
// active search — which is always visible as a removable chip.
import Link from "next/link";
import { Search, X } from "lucide-react";
import { adminListOrders } from "@/services/orders.service";
import { formatPKR, formatDate } from "@/lib/utils";
import { ORDER_STATUSES, STATUS_BADGE_CLASSES } from "@/lib/constants";
import { ExportButtons } from "@/components/admin/export-buttons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders · Admin" };

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = typeof params.status === "string" ? params.status : "";
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const page = Number(typeof params.page === "string" ? params.page : "1") || 1;

  const result = await adminListOrders({ status: status || undefined, q: q || undefined, page });

  // Builds a URL from explicit parts only — nothing is carried over unless it
  // is passed in, so no filter can silently leak into another view (the root
  // cause of the previous "All kept showing the searched order" bug).
  const buildUrl = (parts: { q?: string; status?: string; page?: number }) => {
    const sp = new URLSearchParams();
    const effectiveQ = parts.q !== undefined ? parts.q : q;
    const effectiveStatus = parts.status !== undefined ? parts.status : status;
    if (effectiveQ) sp.set("q", effectiveQ);
    if (effectiveStatus) sp.set("status", effectiveStatus);
    if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
    const qs = sp.toString();
    return qs ? `/admin/orders?${qs}` : "/admin/orders";
  };

  const scopeQuery = [q ? `q=${encodeURIComponent(q)}` : "", status ? `status=${encodeURIComponent(status)}` : ""]
    .filter(Boolean)
    .join("&");
  const hasActiveFilters = Boolean(q || status);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Orders</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {result.total} order{result.total === 1 ? "" : "s"} found
            {q ? (
              <>
                {" "}matching <span className="font-semibold text-foreground">&ldquo;{q}&rdquo;</span>
              </>
            ) : null}
            {status ? <> with status <span className="font-semibold text-foreground">{status.toLowerCase()}</span></> : null}
            {result.pages > 1 ? <> · showing page {result.page} of {result.pages}</> : null}
          </p>
        </div>
        <ExportButtons type="orders" scopeQuery={scopeQuery} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form action="/admin/orders" method="get" className="flex max-w-xs flex-1 gap-2" role="search">
          {status && <input type="hidden" name="status" value={status} />}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              name="q"
              defaultValue={q}
              placeholder="Reference, name, email, phone..."
              className="pl-9 pr-8"
              aria-label="Search orders"
              type="search"
            />
          </div>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <div className="flex flex-wrap gap-1 rounded-lg border bg-card p-1" role="tablist" aria-label="Status filter">
          {/* ALL — a true reset: clears search, status and pagination. */}
          <Link
            href="/admin/orders"
            role="tab"
            aria-selected={!q && !status}
            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${!q && !status ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            All
          </Link>
          {ORDER_STATUSES.map((s) => (
            <Link
              key={s}
              href={buildUrl({ status: s, page: 1 })}
              role="tab"
              aria-selected={status === s}
              className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${status === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </Link>
          ))}
        </div>
      </div>

      {q && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            Search: &ldquo;{q}&rdquo;
            <Link
              href={buildUrl({ q: "", page: 1 })}
              className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
              aria-label={`Clear search “${q}” and show all ${status ? `${status.toLowerCase()} ` : ""}orders`}
              title="Clear search"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </span>
          {status && (
            <span className="inline-flex items-center rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
              Status: {status.toLowerCase()}
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Order</th>
              <th className="px-4 py-3 font-semibold">Customer</th>
              <th className="px-4 py-3 font-semibold">Items</th>
              <th className="px-4 py-3 font-semibold">Total</th>
              <th className="px-4 py-3 font-semibold">Payment</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Date</th>
              <th className="px-4 py-3 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {result.items.map((o) => (
              <tr key={o.id} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <Link href={`/admin/orders/${o.id}`} className="font-mono text-xs font-bold text-primary hover:underline">
                    {o.reference}
                  </Link>
                  {o.isGuest && <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-semibold text-muted-foreground">Guest</span>}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium">{o.customerName}</p>
                  <p className="text-xs text-muted-foreground">{o.customerEmail}</p>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{o.itemCount}</td>
                <td className="px-4 py-3 font-semibold">{formatPKR(o.total)}</td>
                <td className="px-4 py-3">
                  <p className="text-xs">{o.paymentMethod === "COD" ? "COD" : o.paymentMethod.replace("_", " ")}</p>
                  <Badge variant="outline" className={`mt-0.5 ${STATUS_BADGE_CLASSES[o.paymentStatus] ?? ""}`}>
                    {o.paymentStatus}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className={STATUS_BADGE_CLASSES[o.status] ?? ""}>
                    {o.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(o.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/admin/orders/${o.id}`}>Manage</Link>
                  </Button>
                </td>
              </tr>
            ))}
            {result.items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <p className="text-sm font-medium">
                    {hasActiveFilters ? "No orders match your current search or filters." : "No orders yet."}
                  </p>
                  {hasActiveFilters && (
                    <>
                      <p className="mt-1 text-xs text-muted-foreground">
                        The search term or status filter may be too specific.
                      </p>
                      <Button asChild variant="outline" size="sm" className="mt-3">
                        <Link href="/admin/orders">Clear search &amp; filters</Link>
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {result.pages > 1 && (
        <div className="mt-4 flex justify-center gap-2">
          {Array.from({ length: result.pages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={buildUrl({ page: p })}
              className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm font-medium ${
                p === result.page ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"
              }`}
              aria-current={p === result.page ? "page" : undefined}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
