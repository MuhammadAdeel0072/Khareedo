"use client";

// Wishlist grid (FR-05) — move to cart / remove.
import Image from "next/image";
import Link from "next/link";
import { useState, useTransition } from "react";
import { HeartOff, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { AddToCartButton } from "@/components/cart/add-to-cart-button";
import { RatingStars } from "@/components/products/rating-stars";
import { formatPKR, discountPercent } from "@/lib/utils";
import type { WishlistRow } from "@/services/wishlist.service";

export function WishlistGrid({ initial }: { initial: WishlistRow[] }) {
  const [items, setItems] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function remove(productId: string) {
    setPendingId(productId);
    startTransition(async () => {
      try {
        const res = await fetch("/api/wishlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not remove");
        setItems((prev) => prev.filter((i) => i.productId !== productId));
        toast.success("Removed from wishlist");
      } catch {
        toast.error("Could not remove from wishlist");
      } finally {
        setPendingId(null);
      }
    });
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-20 text-center">
        <ShoppingBag className="mx-auto h-12 w-12 text-muted-foreground/40" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-bold">Your wishlist is empty</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tap the heart on any product to save it here for later.
        </p>
        <Link
          href="/products"
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Discover Products
        </Link>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
      {items.map((item) => {
        const off = discountPercent(item.price, item.comparePrice);
        return (
          <article key={item.itemId} className="group flex flex-col overflow-hidden rounded-xl border bg-card">
            <div className="relative aspect-square overflow-hidden bg-muted/40">
              <Link href={`/product/${item.slug}`} aria-label={item.name}>
                <Image
                  src={item.image ?? "/images/placeholder.svg"}
                  alt={item.name}
                  fill
                  sizes="(max-width: 640px) 50vw, 25vw"
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                />
              </Link>
              {off !== null && (
                <span className="absolute left-2 top-2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                  {off}% OFF
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(item.productId)}
                disabled={pendingId === item.productId}
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm transition hover:bg-background disabled:opacity-50"
                aria-label={`Remove ${item.name} from wishlist`}
              >
                <HeartOff className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-1.5 p-3.5">
              <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
                <Link href={`/product/${item.slug}`} className="hover:text-primary">
                  {item.name}
                </Link>
              </h3>
              <RatingStars rating={item.rating} reviewCount={item.reviewCount} />
              <div className="mt-auto flex items-baseline gap-2 pt-1">
                <span className="text-base font-extrabold text-primary">{formatPKR(item.price)}</span>
                {item.comparePrice && item.comparePrice > item.price && (
                  <span className="text-xs text-muted-foreground line-through">{formatPKR(item.comparePrice)}</span>
                )}
              </div>
              <AddToCartButton productId={item.productId} stock={item.stock} size="sm" className="h-9" />
            </div>
          </article>
        );
      })}
    </div>
  );
}
