"use client";

// Cart view — quantity update, remove, per-item gift wrap, subtotal (FR-15/16), empty state.
import Link from "next/link";
import { useState, useTransition } from "react";
import { Gift, Loader2, Minus, Plus, ShoppingBag, Trash2, ArrowRight, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { WhatsAppCartButton } from "@/components/layout/whatsapp-float";
import { cn, formatPKR } from "@/lib/utils";
import type { CartDetails, GuestCartMergeSummary } from "@/types/cart";
import { ProductImage } from "@/components/products/product-image";
import { computeGiftWrapCharge } from "@/lib/pricing";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

/** Why a merged guest-cart line was skipped — same wording as the checkout
 *  flow's merge notice (Phase 3, H-7), so both notices agree. */
function mergeSkipReason(reason: GuestCartMergeSummary["skipped"][number]["reason"]): string {
  return reason === "unavailable"
    ? "no longer available"
    : reason === "out_of_stock"
      ? "out of stock"
      : "already in your cart at the maximum quantity";
}

export function CartView({
  initialCart,
  mergeSummary,
  whatsappNumber,
  storeName,
  freeDeliveryThreshold,
  giftWrapEnabled,
  giftWrapCharge,
}: {
  initialCart: CartDetails | null;
  /** Guest-cart merge report for this page load (Phase 3, H-6/D7) — shown
   *  once, dismissible, exactly like the checkout flow's merge notice. */
  mergeSummary?: GuestCartMergeSummary | null;
  whatsappNumber: string;
  storeName: string;
  freeDeliveryThreshold: number;
  giftWrapEnabled: boolean;
  giftWrapCharge: number;
}) {
  const [cart, setCart] = useState(initialCart);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Guest-cart merge report (Phase 3, H-6/D7): shown once at the top of
  // the cart, dismissible. Empty summaries (nothing merged, nothing
  // skipped) render nothing.
  const [mergeNotice, setMergeNotice] = useState<GuestCartMergeSummary | null>(() =>
    mergeSummary && (mergeSummary.merged.length > 0 || mergeSummary.skipped.length > 0)
      ? mergeSummary
      : null
  );
  // Phase 3, M-13: lines removed on load are named, not silently lost —
  // shown once, dismissible, and extended when a later cart response
  // reports more removals (stock dropped after the page loaded).
  const [removedNotice, setRemovedNotice] = useState(initialCart?.removed ?? []);

  function apply(fn: () => Promise<CartDetails | null>, itemId: string) {
    setPendingId(itemId);
    startTransition(async () => {
      try {
        const next = await fn();
        setCart(next);
        if (next?.removed?.length) {
          setRemovedNotice((prev) => {
            const known = new Set(prev.map((line) => line.productId));
            const fresh = next.removed.filter((line) => !known.has(line.productId));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
        }
        window.dispatchEvent(
          new CustomEvent("cart:updated", { detail: { itemCount: next?.itemCount ?? 0 } })
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not update cart");
      } finally {
        setPendingId(null);
      }
    });
  }

  const updateQty = (itemId: string, quantity: number, name?: string) =>
    apply(async () => {
      const res = await fetchWithTimeout("/api/cart", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, quantity }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not update cart");
      // Minus at qty 1 deletes the line (quantity 0): say so, naming the
      // item (Phase 3, chunk 12 follow-up B) — it used to vanish silently
      // with no feedback. Same toast style as removeItem.
      if (quantity === 0 && name) toast.success(`"${name}" removed from cart`);
      return data.cart as CartDetails;
    }, itemId);

  const removeItem = (itemId: string) =>
    apply(async () => {
      const res = await fetchWithTimeout("/api/cart", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not remove item");
      toast.success("Item removed from cart");
      return data.cart as CartDetails;
    }, itemId);

  const toggleGiftWrap = (itemId: string, wrap: boolean) =>
    apply(async () => {
      const res = await fetchWithTimeout("/api/cart", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, giftWrap: wrap }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not update gift wrap");
      return data.cart as CartDetails;
    }, itemId);

  if (!cart || cart.items.length === 0) {
    return (
      <>
        {mergeNotice && (
          <div className="mb-4 rounded-xl border border-primary/30 bg-brand-50 p-3.5" role="status">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {mergeNotice.skipped.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Couldn&apos;t add {mergeNotice.skipped.length} item{mergeNotice.skipped.length === 1 ? "" : "s"}:{" "}
                    {mergeNotice.skipped
                      .map((line) => `${line.name} (${mergeSkipReason(line.reason)})`)
                      .join(", ")}
                    .
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setMergeNotice(null)}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Dismiss merge notice"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed py-24 text-center">
        <ShoppingBag className="h-14 w-14 text-muted-foreground/40" aria-hidden="true" />
        <h2 className="mt-4 text-xl font-bold">Your cart is empty</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Looks like you haven&apos;t added anything yet. Explore our collections and find
          something you love.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/products">
            Start Shopping <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
        </div>
      </>
    );
  }

  const remainingForFree = Math.max(0, freeDeliveryThreshold - cart.subtotal);
  const progress = Math.min(100, Math.round((cart.subtotal / freeDeliveryThreshold) * 100));
  // Phase 3, M-14: the checkout CTAs are live only when the cart holds at
  // least one purchasable unit. Lines with no stock are dropped on load
  // (M-13), so this normally never triggers — it guards the window where
  // stock dropped after the page loaded, instead of sending the customer
  // to a checkout that would reject an empty cart.
  const canCheckout = cart.itemCount > 0;
  const giftWrapTotal = computeGiftWrapCharge(cart.wrappedUnits, {
    enabled: giftWrapEnabled,
    charge: giftWrapCharge,
  });
  const estimatedTotal = cart.subtotal + giftWrapTotal;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 pb-24 lg:grid-cols-[1fr_380px] lg:pb-0">
      {/* Items */}
      <div className="min-w-0">
        {mergeNotice && (
          <div className="mb-4 rounded-xl border border-primary/30 bg-brand-50 p-3.5" role="status">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {mergeNotice.merged.length > 0 && (
                  <p className="text-sm font-semibold">
                    Your guest cart was merged — {mergeNotice.merged.length} item{mergeNotice.merged.length === 1 ? "" : "s"} added to your cart.
                  </p>
                )}
                {mergeNotice.skipped.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Couldn&apos;t add {mergeNotice.skipped.length} item{mergeNotice.skipped.length === 1 ? "" : "s"}:{" "}
                    {mergeNotice.skipped
                      .map((line) => `${line.name} (${mergeSkipReason(line.reason)})`)
                      .join(", ")}
                    .
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setMergeNotice(null)}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Dismiss merge notice"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {removedNotice.length > 0 && (
          <div className="mb-4 rounded-xl border border-warning/40 bg-warning/5 p-3.5" role="status">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm">
                <span className="font-semibold">
                  {removedNotice.length} item{removedNotice.length === 1 ? "" : "s"} removed from your cart
                </span>{" "}
                — {removedNotice.map((line) => line.name).join(", ")} {removedNotice.length === 1 ? "is" : "are"} no
                longer available.
              </p>
              <button
                type="button"
                onClick={() => setRemovedNotice([])}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Dismiss removed items notice"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {remainingForFree > 0 && (
          <div className="mb-4 rounded-xl border border-primary/20 bg-brand-50 p-3.5">
            <p className="text-sm">
              <span className="font-semibold text-primary">
                Add {formatPKR(remainingForFree)} more
              </span>{" "}
              to unlock <span className="font-semibold">FREE standard delivery</span>
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-brand-100">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Progress to free delivery"
              />
            </div>
          </div>
        )}

        <ul className="divide-y rounded-xl border">
          {cart.items.map((item) => (
            <li key={item.itemId} className="flex min-w-0 gap-4 p-4">
              <Link
                href={`/product/${item.slug}`}
                className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-muted sm:h-28 sm:w-28"
              >
                <ProductImage
                  src={item.image}
                  alt={item.name}
                  fill
                  sizes="112px"
                  className="object-cover"
                />
              </Link>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold sm:text-base">
                      <Link href={`/product/${item.slug}`} className="hover:text-primary">
                        {item.name}
                      </Link>
                    </h3>
                    {item.variantLabel ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.variantLabel}</p>
                    ) : null}
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {formatPKR(item.price)} each
                    </p>
                    {item.outOfStock ? (
                      <p className="mt-1 text-xs font-medium text-destructive">
                        Out of stock — remove to checkout
                      </p>
                    ) : item.lowStock ? (
                      <p className="mt-1 text-xs font-medium text-warning">
                        Hurry — only {item.stock} left
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-sm font-bold sm:text-base">
                    {formatPKR(item.lineTotal)}
                  </span>
                </div>

                <div className="mt-auto flex items-center gap-3 pt-2">
                  <div className="inline-flex items-center rounded-lg border" role="group" aria-label={`Quantity for ${item.name}`}>
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-l-lg transition hover:bg-muted disabled:opacity-50"
                      onClick={() => updateQty(item.itemId, item.quantity - 1, item.name)}
                      disabled={pendingId === item.itemId}
                      aria-label="Decrease quantity"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="w-9 text-center text-sm font-semibold tabular-nums">
                      {pendingId === item.itemId ? (
                        <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" aria-label="Updating" />
                      ) : (
                        item.quantity
                      )}
                    </span>
                    <button
                      type="button"
                      className="flex h-10 w-10 items-center justify-center rounded-r-lg transition hover:bg-muted disabled:opacity-50"
                      onClick={() => updateQty(item.itemId, item.quantity + 1)}
                      disabled={pendingId === item.itemId || item.quantity >= item.stock}
                      aria-label="Increase quantity"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(item.itemId)}
                    disabled={pendingId === item.itemId}
                    className="flex h-10 items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-destructive disabled:opacity-50"
                    aria-label={`Remove ${item.name} from cart`}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </button>
                </div>

                {/* Per-item gift wrap — the toggle is attached to THIS product, not the whole order */}
                {giftWrapEnabled && !item.outOfStock && (
                  <label
                    className={cn(
                      "mt-2 flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition select-none",
                      item.giftWrap ? "border-primary/50 bg-brand-50" : "border-dashed hover:border-muted-foreground/40"
                    )}
                  >
                    <Checkbox
                      checked={item.giftWrap}
                      onCheckedChange={(c) => toggleGiftWrap(item.itemId, c === true)}
                      disabled={pendingId === item.itemId}
                      aria-label={`Gift wrap ${item.name}`}
                    />
                    <Gift className={cn("h-4 w-4 shrink-0", item.giftWrap ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-xs leading-4">
                      <span className={cn("block font-semibold", item.giftWrap ? "text-primary" : "text-foreground")}>
                        Gift wrap this item
                      </span>
                      <span className="block text-muted-foreground">
                        {formatPKR(giftWrapCharge)} per item · {item.quantity} unit{item.quantity === 1 ? "" : "s"} = {formatPKR(giftWrapCharge * item.quantity)}
                      </span>
                    </span>
                  </label>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Summary */}
      <div className="h-fit rounded-xl border p-5 lg:sticky lg:top-40">
        <h2 className="text-lg font-bold">Order Summary</h2>
        <div className="mt-4 space-y-2.5 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal ({cart.itemCount} items)</span>
            <span className="font-semibold">{formatPKR(cart.subtotal)}</span>
          </div>
          {giftWrapTotal > 0 && (
            <div className="flex justify-between">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Gift className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                Gift wrapping ({cart.wrappedUnits} item{cart.wrappedUnits === 1 ? "" : "s"})
              </span>
              <span className="font-semibold">{formatPKR(giftWrapTotal)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Delivery</span>
            <span className="text-muted-foreground">Calculated at checkout</span>
          </div>
        </div>
        <Separator className="my-4" />
        <div className="flex justify-between text-base">
          {/* "Estimated Total" was misleading (Phase 3, chunk 12
              follow-up B): the figure excludes delivery and any discount,
              but was presented as the total. It is the subtotal — delivery
              is calculated at checkout, as stated above. */}
          <span className="font-bold">Subtotal</span>
          <span className="font-extrabold text-primary">{formatPKR(estimatedTotal)}</span>
        </div>
        {canCheckout ? (
          <Button asChild size="lg" className="mt-4 h-12 w-full text-base">
            <Link href="/checkout">Proceed to Checkout</Link>
          </Button>
        ) : (
          <Button size="lg" disabled className="mt-4 h-12 w-full text-base">
            Proceed to Checkout
          </Button>
        )}
        {!canCheckout && (
          <p className="mt-2 text-center text-xs text-muted-foreground" role="status">
            No items in your cart are available to purchase right now.
          </p>
        )}
        <Button asChild variant="ghost" className="mt-2 w-full">
          <Link href="/products">Continue Shopping</Link>
        </Button>

        <div className="mt-4 border-t pt-4">
          <WhatsAppCartButton
            number={whatsappNumber}
            storeName={storeName}
            items={cart.items.map((i) => ({ name: i.name, quantity: i.quantity }))}
            subtotal={cart.subtotal}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-whatsapp/40 text-sm font-medium text-whatsapp-dark transition-colors hover:bg-whatsapp/10"
          />
          <p className="mt-2 text-center text-[11px] leading-4 text-muted-foreground">
            WhatsApp chat is an inquiry only — not a confirmed order.
          </p>
        </div>
      </div>

      {/* Mobile sticky checkout bar — total + CTA always reachable without scrolling */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90 lg:hidden">
        <div className="container-khd flex items-center gap-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="min-w-0 leading-tight">
            {canCheckout ? (
              <>
                <p className="text-[11px] text-muted-foreground">
                  {cart.itemCount} item{cart.itemCount === 1 ? "" : "s"}
                </p>
                <p className="truncate text-lg font-extrabold text-primary">{formatPKR(estimatedTotal)}</p>
              </>
            ) : (
              <p className="text-xs leading-4 text-muted-foreground">
                No items available to purchase right now.
              </p>
            )}
          </div>
          {canCheckout ? (
            <Button asChild size="lg" className="ml-auto h-11 min-w-0 flex-1 justify-center text-base sm:max-w-64">
              <Link href="/checkout">Checkout</Link>
            </Button>
          ) : (
            <Button size="lg" disabled className="ml-auto h-11 min-w-0 flex-1 justify-center text-base sm:max-w-64">
              Checkout
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function CartSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
