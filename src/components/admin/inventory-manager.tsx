"use client";

// Admin inventory manager (FR-40) — inline stock editing with validation.
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { InventoryRow } from "@/services/inventory.service";

export function InventoryManager({ initial }: { initial: InventoryRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "low" | "out">("all");
  const [editing, setEditing] = useState<Record<string, number | string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    let out = rows;
    if (q.trim()) out = out.filter((r) => r.productName.toLowerCase().includes(q.trim().toLowerCase()));
    if (filter === "low") out = out.filter((r) => r.isLow);
    if (filter === "out") out = out.filter((r) => r.isOut);
    return out;
  }, [rows, q, filter]);

  function save(row: InventoryRow) {
    const raw = editing[row.productId];
    const quantity = Number(raw ?? row.quantity);
    if (!Number.isInteger(quantity) || quantity < 0) {
      toast.error("Stock must be a whole number of 0 or more");
      return;
    }
    setSavingId(row.productId);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/inventory", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: row.productId, quantity }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Update failed");
        setRows((prev) =>
          prev.map((r) =>
            r.productId === row.productId
              ? { ...r, quantity, isOut: quantity === 0, isLow: quantity > 0 && quantity <= r.lowStockThreshold }
              : r
          )
        );
        toast.success(`Stock updated for "${row.productName}"`);
        setEditing((e) => {
          const next = { ...e };
          delete next[row.productId];
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
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products..." className="pl-9" aria-label="Search inventory" />
        </div>
        <div className="flex gap-1 rounded-lg border bg-card p-1" role="tablist" aria-label="Stock filter">
          {(["all", "low", "out"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition",
                filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "all" ? "All" : f === "low" ? "Low stock" : "Out of stock"}
            </button>
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
            {filtered.map((row) => (
              <tr key={row.productId} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <p className="font-medium">{row.productName}</p>
                  {row.isLow && !row.isOut && (
                    <p className="text-xs font-semibold text-amber-600">Low stock — {row.quantity} left</p>
                  )}
                  {row.isOut && <p className="text-xs font-semibold text-red-600">Out of stock</p>}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{row.category}</td>
                <td className="px-4 py-3">
                  <span className={cn("font-bold", row.isOut ? "text-red-600" : row.isLow ? "text-amber-600" : "")}>
                    {row.quantity}
                  </span>
                  <span className="ml-1 text-xs text-muted-foreground">/ low at {row.lowStockThreshold}</span>
                </td>
                <td className="px-4 py-3">
                  <Input
                    type="number"
                    min={0}
                    value={editing[row.productId] ?? row.quantity}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [row.productId]: e.target.value }))}
                    className="h-9 w-28"
                    aria-label={`New stock for ${row.productName}`}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    onClick={() => save(row)}
                    disabled={savingId === row.productId || editing[row.productId] === undefined || Number(editing[row.productId]) === row.quantity}
                    className="gap-1.5"
                  >
                    {savingId === row.productId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Update
                  </Button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No products match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
