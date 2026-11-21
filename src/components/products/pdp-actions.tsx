"use client";

// PDP purchase panel — quantity selector + Add to Cart / Buy Now.
// Desktop (lg+): in-flow panel under the price. Mobile: sticky bottom purchase bar so the
// primary actions stay reachable while scrolling (Daraz/Amazon pattern).
import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { AddToCartButton, BuyNowButton } from "@/components/cart/add-to-cart-button";
import { QuantitySelector } from "@/components/products/product-gallery";
import { formatPKR } from "@/lib/utils";
import type { VariantDetail } from "@/services/variants.service";

export function PdpActions({
  productId,
  stock,
  price,
  variants = [],
}: {
  productId: string;
  /** Total stock across all rows (product-level + variants) — the ceiling
   *  for a variant-less product. */
  stock: number;
  price: number;
  /** Active variants, in display order (Chunk 8 — D12). Empty = no variants. */
  variants?: VariantDetail[];
}) {
  const [qty, setQty] = useState(1);
  // Default to the first variant with stock, else the first variant: a
  // variant product always buys ONE variant, never "the product" — the
  // product-level row is only stock for variant-less products.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (variants.length === 0) return null;
    return variants.find((v) => v.stock > 0)?.id ?? variants[0].id;
  });
  const selected = variants.find((v) => v.id === selectedId) ?? null;
  // Effective price/stock follow the SELECTED variant: its absolute override
  // replaces the product price, its own row is the stock. Server-side
  // re-validates both at add-to-cart time; this is display only.
  const effectivePrice = selected ? (selected.priceOverride ?? price) : price;
  const effectiveStock = selected ? selected.stock : stock;
  const purchaseActionsRef = useRef<HTMLDivElement>(null);
  // True while the product section is on screen. The sticky bar shows
  // when it is NOT — i.e. once the customer has scrolled past the
  // in-flow actions (Phase 3, chunk 12 follow-up B). The condition used
  // to be inverted: the bar showed while the section was visible and
  // vanished the moment the customer scrolled past it, leaving mobile
  // with no buy CTA. Initial true when an IntersectionObserver exists
  // (at the top of the page the section is visible, so the bar starts
  // hidden until the observer reports); false without one, so the bar
  // stays visible always — the in-flow panel is hidden on mobile and
  // the sticky bar is the only buy CTA there.
  const [productSectionActive, setProductSectionActive] = useState(
    () => typeof window === "undefined" || "IntersectionObserver" in window
  );
  // Phase 3, M-14: the stepper ceiling is the cart API cap (20), never above
  // available stock — the old hardcoded 10 stopped customers adding 11–20
  // units the API would have accepted. For a variant product the ceiling is
  // the SELECTED variant's stock, not the product total.
  const max = Math.max(1, Math.min(effectiveStock, 20));
  const inStock = effectiveStock > 0;

  // Clamp the quantity when the selected variant changes to one with less
  // stock. Done in the click handler (not an effect): setState inside an
  // effect body is a lint error in this codebase.
  function selectVariant(v: VariantDetail) {
    setSelectedId(v.id);
    setQty((q) => Math.min(q, Math.max(1, Math.min(v.stock, 20))));
  }

  useEffect(() => {
    const section = purchaseActionsRef.current?.closest("[data-product-main]");
    if (!section || !("IntersectionObserver" in window)) return;

    const observer = new IntersectionObserver(
      ([entry]) => setProductSectionActive(entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* ── lg+ in-flow panel ── */}
      <div ref={purchaseActionsRef} className="mt-6 hidden lg:block">
        {variants.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-sm font-medium text-muted-foreground" id="variant-label">
              Select variant{selected ? `: ${selected.label}` : ""}
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="variant-label">
              {variants.map((v) => {
                const isSelected = v.id === selectedId;
                const outOfStock = v.stock <= 0;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => selectVariant(v)}
                    disabled={outOfStock}
                    aria-pressed={isSelected}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      isSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted-foreground/30 hover:border-muted-foreground/60"
                    }`}
                  >
                    {v.label}
                    {outOfStock ? " — Out of stock" : ""}
                  </button>
                );
              })}
            </div>
            {selected && (
              <p className="mt-2 text-sm text-muted-foreground">
                {formatPKR(effectivePrice)}
                {selected.priceOverride !== null && selected.priceOverride !== price
                  ? ` (was ${formatPKR(price)})`
                  : ""}
                {" · "}
                {selected.stock > 0 ? `${selected.stock} in stock` : "Out of stock"}
              </p>
            )}
          </div>
        )}
        {!inStock && (
          <p className="mb-3 text-sm font-medium text-destructive" role="status">
            This item is currently out of stock — check back soon.
          </p>
        )}
        {inStock && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">Quantity</span>
            <QuantitySelector value={qty} onChange={setQty} max={max} />
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <AddToCartButton
            productId={productId}
            stock={effectiveStock}
            quantity={qty}
            variantId={selected?.id}
            size="lg"
            className="h-12 text-base"
          />
          <BuyNowButton
            productId={productId}
            stock={effectiveStock}
            quantity={qty}
            variantId={selected?.id}
            size="lg"
            className="h-12 text-base"
          />
        </div>
      </div>

      {/* ── Mobile sticky purchase bar ──
          Visible once the product section has scrolled out of view, so
          the buy CTA persists while scrolling (see the state comment
          above). */}
      {!productSectionActive && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90 lg:hidden">
          {variants.length > 0 && (
            <div className="container-khd flex gap-2 overflow-x-auto pt-2.5 pb-0" role="group" aria-label="Select variant">
              {variants.map((v) => {
                const isSelected = v.id === selectedId;
                const outOfStock = v.stock <= 0;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => selectVariant(v)}
                    disabled={outOfStock}
                    aria-pressed={isSelected}
                    className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                      isSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted-foreground/30"
                    }`}
                  >
                    {v.label}
                    {outOfStock ? " — Out" : ""}
                  </button>
                );
              })}
            </div>
          )}
          <div className="container-khd flex items-center gap-2.5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            {inStock && (
              <div
                className="inline-flex shrink-0 items-center rounded-lg border"
                role="group"
                aria-label="Quantity"
              >
                <button
                  type="button"
                  className="flex h-11 w-8 items-center justify-center rounded-l-lg transition hover:bg-muted disabled:opacity-40 min-[360px]:w-9"
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                  disabled={qty <= 1}
                  aria-label="Decrease quantity"
                >
                  <Minus className="h-4 w-4" aria-hidden="true" />
                </button>
                <span className="w-6 text-center text-sm font-bold tabular-nums" aria-live="polite">
                  {qty}
                </span>
                <button
                  type="button"
                  className="flex h-11 w-8 items-center justify-center rounded-r-lg transition hover:bg-muted disabled:opacity-40 min-[360px]:w-9"
                  onClick={() => setQty((q) => Math.min(max, q + 1))}
                  disabled={qty >= max}
                  aria-label="Increase quantity"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}
            <AddToCartButton
              productId={productId}
              stock={effectiveStock}
              quantity={qty}
              variantId={selected?.id}
              className="h-11 min-w-0 flex-1 px-2 text-xs min-[360px]:px-3 min-[360px]:text-sm"
              showIcon={false}
            />
            <BuyNowButton
              productId={productId}
              stock={effectiveStock}
              quantity={qty}
              variantId={selected?.id}
              className="h-11 min-w-0 flex-1 px-2 text-xs min-[360px]:px-3 min-[360px]:text-sm"
            />
          </div>
        </div>
      )}
    </>
  );
}
