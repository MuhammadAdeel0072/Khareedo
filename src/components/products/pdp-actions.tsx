"use client";

// PDP purchase panel — quantity selector + Add to Cart / Buy Now.
// Desktop (lg+): in-flow panel under the price. Mobile: sticky bottom purchase bar so the
// primary actions stay reachable while scrolling (Daraz/Amazon pattern).
import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { AddToCartButton, BuyNowButton } from "@/components/cart/add-to-cart-button";
import { QuantitySelector } from "@/components/products/product-gallery";

export function PdpActions({
  productId,
  stock,
  price,
}: {
  productId: string;
  stock: number;
  price: number;
}) {
  const [qty, setQty] = useState(1);
  const purchaseActionsRef = useRef<HTMLDivElement>(null);
  const [productSectionActive, setProductSectionActive] = useState(false);
  const max = Math.max(1, Math.min(stock, 10));
  const inStock = stock > 0;

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
        {inStock && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">Quantity</span>
            <QuantitySelector value={qty} onChange={setQty} max={max} />
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <AddToCartButton
            productId={productId}
            stock={stock}
            quantity={qty}
            size="lg"
            className="h-12 text-base"
          />
          <BuyNowButton
            productId={productId}
            stock={stock}
            quantity={qty}
            size="lg"
            className="h-12 text-base"
          />
        </div>
      </div>

      {/* ── Mobile sticky purchase bar ── */}
      {productSectionActive && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90 lg:hidden">
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
              stock={stock}
              quantity={qty}
              className="h-11 min-w-0 flex-1 px-2 text-xs min-[360px]:px-3 min-[360px]:text-sm"
              showIcon={false}
            />
            <BuyNowButton
              productId={productId}
              stock={stock}
              quantity={qty}
              className="h-11 min-w-0 flex-1 px-2 text-xs min-[360px]:px-3 min-[360px]:text-sm"
            />
          </div>
        </div>
      )}
    </>
  );
}
