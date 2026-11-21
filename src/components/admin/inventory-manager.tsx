"use client";

// Admin inventory manager (FR-40) — inline stock editing with validation.
// Search, stock filter and pagination are server-driven (query string, like
// the admin orders list): with a paginated list, client-side filtering over
// the current page would silently miss rows on other pages.
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { InventoryDriftItem, InventoryDriftReason, InventoryRow } from "@/services/inventory.service";

const DRIFT_REASON_LABELS: Record<InventoryDriftReason, string> = {
  ORDER_CLOSED: "order closed but hold never released",
  ORDER_SETTLED: "order settled but hold never consumed",
  QUANTITY_MISMATCH: "held quantity differs from the order line",
  EXPIRED: "reservation expired but still holding stock",
};

export type InventoryFilter = "all" | "low" | "out";

export function InventoryManager({ initial, drift, q, filter, page, pages, total }: {
  initial: InventoryRow[];
  drift: { count: number; items: InventoryDriftItem[] };
  q: string;
  filter: InventoryFilter;
  page: number;
  pages: number;
  total: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [editing, setEditing] = useState<Record<string, number | string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Builds a URL from explicit parts only — nothing is carried over unless
  // it is passed in, so no filter can silently leak into another view.
  const buildUrl = (parts: { q?: string; filter?: InventoryFilter; page?: number }) => {
    const sp = new URLSearchParams();
    const effectiveQ = parts.q !== undefined ? parts.q : q;
    const effectiveFilter = parts.filter !== undefined ? parts.filter : filter;
    if (effectiveQ) sp.set("q", effectiveQ);
    if (effectiveFilter && effectiveFilter !== "all") sp.set("filter", effectiveFilter);
    if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
    const qs = sp.toString();
    return qs ? `/admin/inventory?${qs}` : "/admin/inventory";
  };

  // Rows are keyed by (product, variant): a variant product has one row
  // per variant plus its product-level row (Chunk 8 — D12).
  function rowKey(row: InventoryRow) {
    return `${row.productId}:${row.variantId ?? ""}`;
  }

  function save(row: InventoryRow) {
    const key = rowKey(row);
    const raw = editing[key];
    const quantity = Number(raw ?? row.quantity);
    if (!Number.isInteger(quantity) || quantity < 0) {
      toast.error("Stock must be a whole number of 0 or more");
      return;
    }
    setSavingId(key);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/inventory", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: row.productId, variantId: row.variantId, quantity }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Update failed");
        setRows((prev) =>
          prev.map((r) =>
            rowKey(r) === key
              ? { ...r, quantity, isOut: quantity === 0, isLow: quantity > 0 && quantity <= r.lowStockThreshold }
              : r
          )
        );
        toast.success(`Stock updated for "${row.productName}${row.variantLabel ? ` (${row.variantLabel})` : ""}"`);
        setEditing((e) => {
          const next = { ...e };
          delete next[key];
          return next;
        });
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not update stock");
      } finally {
        setSavingId(null);
      }
    });
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Inventory</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View and update stock levels — stock is re-validated at every order
          {total > 0 ? <> · {total} product{total === 1 ? "" : "s"}</> : null}
          {pages > 1 ? <> · showing page {page} of {pages}</> : null}
        </p>
      </div>

      {drift.count > 0 && (
        <div className="mb-4 rounded-xl border border-warning/50 bg-warning/10 p-4" role="alert">
          <p className="text-sm font-bold">
            {drift.count} reservation{drift.count === 1 ? "" : "s"} holding stock without a live order
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            These payment holds decremented stock but their orders no longer justify them.
            Investigate the orders below — the stock stays locked until the hold is released
            or consumed through payment review.
          </p>
          <ul className="mt-3 space-y-1 text-xs">
            {drift.items.map((item) => (
              <li key={item.reservationId}>
                <span className="font-semibold">{item.productName}</span> — order{" "}
                <span className="font-mono">{item.orderReference}</span> ({item.orderStatus}):{" "}
                {item.heldQuantity} held
                {item.heldQuantity !== item.orderItemQuantity &&
                  `, order line is ${item.orderItemQuantity}`}{" "}
                — {item.reasons.map((r) => DRIFT_REASON_LABELS[r]).join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form action="/admin/inventory" method="get" className="flex max-w-xs flex-1 gap-2" role="search">
          {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input name="q" defaultValue={q} placeholder="Search products..." className="pl-9" aria-label="Search inventory" type="search" />
          </div>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <div className="flex gap-1 rounded-lg border bg-card p-1" role="tablist" aria-label="Stock filter">
          {(["all", "low", "out"] as const).map((f) => (
            <Link
              key={f}
              href={buildUrl({ filter: f, page: 1 })}
              role="tab"
              aria-selected={filter === f}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition",
                filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "all" ? "All" : f === "low" ? "Low stock" : "Out of stock"}
            </Link>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Product</th>
              <th className="px-4 py-3 font-semibold">Category</th>
              <th className="px-4 py-3 font-semibold">Current Stock</th>
              <th className="px-4 py-3 font-semibold">Set New Stock</th>
              <th className="px-4 py-3 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={rowKey(row)} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <p className="font-medium">{row.productName}</p>
                  {row.variantLabel ? (
                    <p className="text-xs text-muted-foreground">{row.variantLabel}</p>
                  ) : null}
                  {row.isLow && !row.isOut && (
                    <p className="text-xs font-semibold text-warning">Low stock — {row.quantity} left</p>
                  )}
                  {row.isOut && (
                    <p className="text-xs font-semibold text-destructive">
                      {row.heldQuantity > 0
                        ? `Out of stock — ${row.heldQuantity} held`
                        : "Out of stock"}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{row.category}</td>
                <td className="px-4 py-3">
                  <span className={cn("font-bold", row.isOut ? "text-destructive" : row.isLow ? "text-warning" : "")}>
                    {row.quantity}
                  </span>
                  <span className="ml-1 text-xs text-muted-foreground">/ low at {row.lowStockThreshold}</span>
                  {row.heldQuantity > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {row.heldQuantity} held for pending payment{row.heldQuantity === 1 ? "" : "s"}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Input
                    type="number"
                    min={0}
                    value={editing[rowKey(row)] ?? row.quantity}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [rowKey(row)]: e.target.value }))}
                    className="h-9 w-28"
                    aria-label={`New stock for ${row.productName}${row.variantLabel ? ` (${row.variantLabel})` : ""}`}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    onClick={() => save(row)}
                    disabled={savingId === rowKey(row) || editing[rowKey(row)] === undefined || Number(editing[rowKey(row)]) === row.quantity}
                    className="gap-1.5"
                  >
                    {savingId === rowKey(row) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Update
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No products match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="mt-4 flex justify-center gap-2">
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={buildUrl({ page: p })}
              className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm font-medium ${
                p === page ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"
              }`}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
