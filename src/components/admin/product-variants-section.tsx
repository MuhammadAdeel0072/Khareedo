"use client";

// Product variants section (Chunk 8 — D12) — lives inside the product edit
// dialog. Lists a product's variants with per-variant stock and price
// override, and lets an admin add, edit, or deactivate them. There is no
// delete in V1: deactivation (isActive: false) is the removal path, so
// order history that snapshots the variant survives.
import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { formatPKR } from "@/lib/utils";
// The variant endpoints return { variants } / { variant } payloads, which
// readAdminApiResponse strips (it only keeps ok/error/url/product/errors),
// so this component parses the JSON directly.

interface VariantRow {
  id: string;
  label: string;
  sku: string;
  priceOverride: number | null;
  isActive: boolean;
  sortOrder: number;
  stock: number;
  lowStockThreshold: number;
}

export function ProductVariantsSection({ productId, productPrice }: { productId: string; productPrice: number }) {
  const [variants, setVariants] = useState<VariantRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newSku, setNewSku] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newStock, setNewStock] = useState("0");
  // Draft edits per variant id, applied on Save. Written out explicitly:
  // Partial<VariantRow> would type priceOverride/stock as numbers only,
  // but the inputs hold strings while the admin types.
  const [drafts, setDrafts] = useState<
    Record<string, { label?: string; sku?: string; priceOverride?: number | string | null; stock?: number | string; isActive?: boolean }>
  >({});

  // Fetch is an inline promise chain: setState only happens inside .then()
  // callbacks (async continuations), never synchronously in the effect body
  // — the latter is a lint error in this codebase.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/products/${productId}/variants`)
      .then((res) => res.json() as Promise<{ ok: boolean; error?: string; variants?: VariantRow[] }>)
      .then((data) => {
        if (cancelled) return;
        if (!data.ok) throw new Error(data.error ?? "Could not load variants");
        setVariants(data.variants ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error("Could not load variants");
        setVariants([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  function draft(id: string) {
    return drafts[id] ?? {};
  }

  function setDraft(id: string, patch: { label?: string; sku?: string; priceOverride?: number | string | null; stock?: number | string; isActive?: boolean }) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function saveVariant(v: VariantRow) {
    const d = draft(v.id);
    const body: Record<string, unknown> = {};
    if (d.label !== undefined && d.label !== v.label) body.label = d.label;
    if (d.sku !== undefined && d.sku !== v.sku) body.sku = d.sku;
    if (d.priceOverride !== undefined) {
      body.priceOverride = d.priceOverride === "" || d.priceOverride === null ? null : Number(d.priceOverride);
    }
    if (d.stock !== undefined && Number(d.stock) !== v.stock) body.stock = Number(d.stock);
    if (d.isActive !== undefined && d.isActive !== v.isActive) body.isActive = d.isActive;
    if (Object.keys(body).length === 0) return;
    setSavingId(v.id);
    try {
      const res = await fetch(`/api/admin/products/${productId}/variants/${v.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; variant?: VariantRow };
      if (!res.ok || !data.ok || !data.variant) throw new Error(data.error ?? "Could not save variant");
      const updated = data.variant;
      setVariants((prev) => prev?.map((row) => (row.id === v.id ? updated : row)) ?? null);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[v.id];
        return next;
      });
      toast.success(`Variant "${updated.label}" saved`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save variant");
    } finally {
      setSavingId(null);
    }
  }

  async function addVariant() {
    const label = newLabel.trim();
    const sku = newSku.trim();
    if (!label || !sku) {
      toast.error("Variant label and SKU are both required");
      return;
    }
    const stock = Number(newStock);
    if (!Number.isInteger(stock) || stock < 0) {
      toast.error("Stock must be a whole number of 0 or more");
      return;
    }
    const priceOverride = newPrice.trim() === "" ? null : Number(newPrice);
    if (priceOverride !== null && (!Number.isInteger(priceOverride) || priceOverride < 1)) {
      toast.error("Price override must be a whole number greater than 0, or empty to inherit the product price");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/products/${productId}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, sku, priceOverride, stock }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; variant?: VariantRow };
      if (!res.ok || !data.ok || !data.variant) throw new Error(data.error ?? "Could not add variant");
      const created = data.variant;
      setVariants((prev) => [...(prev ?? []), created]);
      setNewLabel("");
      setNewSku("");
      setNewPrice("");
      setNewStock("0");
      toast.success(`Variant "${created.label}" added`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add variant");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="rounded-xl border bg-muted/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold">Variants</h3>
        <p className="text-xs text-muted-foreground">
          One row per option (e.g. “Size: M”). Stock and price are per variant.
        </p>
      </div>

      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading variants…
        </p>
      ) : variants && variants.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {variants.map((v) => {
            const d = draft(v.id);
            const dirty =
              (d.label !== undefined && d.label !== v.label) ||
              (d.sku !== undefined && d.sku !== v.sku) ||
              d.priceOverride !== undefined ||
              (d.stock !== undefined && Number(d.stock) !== v.stock) ||
              (d.isActive !== undefined && d.isActive !== v.isActive);
            return (
              <li key={v.id} className="rounded-lg border bg-card p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs">Label</Label>
                    <Input
                      value={d.label ?? v.label}
                      onChange={(e) => setDraft(v.id, { label: e.target.value })}
                      className="mt-1 h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">SKU</Label>
                    <Input
                      value={d.sku ?? v.sku}
                      onChange={(e) => setDraft(v.id, { sku: e.target.value })}
                      className="mt-1 h-9 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Price override (Rs) — empty inherits {formatPKR(productPrice)}</Label>
                    <Input
                      type="number"
                      min={1}
                      // `??` would resurrect the saved value when the draft
                      // is null (field cleared = inherit price), so test the
                      // key, not the value.
                      value={"priceOverride" in d ? (d.priceOverride ?? "") : (v.priceOverride ?? "")}
                      onChange={(e) => setDraft(v.id, { priceOverride: e.target.value === "" ? null : e.target.value })}
                      className="mt-1 h-9"
                      placeholder={String(productPrice)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Stock</Label>
                    <Input
                      type="number"
                      min={0}
                      value={d.stock ?? v.stock}
                      onChange={(e) => setDraft(v.id, { stock: e.target.value })}
                      className="mt-1 h-9"
                    />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={d.isActive ?? v.isActive}
                      onCheckedChange={(c) => setDraft(v.id, { isActive: c === true })}
                    />
                    Active
                  </label>
                  {!v.isActive && (
                    <span className="text-xs text-muted-foreground">Inactive variants are hidden from the storefront.</span>
                  )}
                  <span className="ml-auto" />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!dirty || savingId === v.id}
                    onClick={() => void saveVariant(v)}
                  >
                    {savingId === v.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Save
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No variants yet — this product sells as a single item. Add a variant below to offer options.
        </p>
      )}

      <div className="mt-4 border-t pt-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add variant</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Label — e.g. Size: M" className="h-9" aria-label="New variant label" />
          <Input value={newSku} onChange={(e) => setNewSku(e.target.value)} placeholder="SKU" className="h-9 font-mono text-xs" aria-label="New variant SKU" />
          <Input type="number" min={1} value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder={`Price (default ${productPrice})`} className="h-9" aria-label="New variant price override" />
          <Input type="number" min={0} value={newStock} onChange={(e) => setNewStock(e.target.value)} placeholder="Stock" className="h-9" aria-label="New variant stock" />
        </div>
        <Button type="button" size="sm" variant="secondary" className="mt-2 gap-1.5" onClick={() => void addVariant()} disabled={adding}>
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add Variant
        </Button>
      </div>
    </div>
  );
}
