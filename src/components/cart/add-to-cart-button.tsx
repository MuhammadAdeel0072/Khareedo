"use client";

// Add to cart / Buy now — calls server API, dispatches cart:updated for badge refresh (FR-14).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, ShoppingCart, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CartResponse {
  ok: boolean;
  cart?: { itemCount: number };
  error?: string;
}

async function addToCartApi(productId: string, quantity: number): Promise<CartResponse> {
  const res = await fetch("/api/cart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, quantity }),
  });
  const data: CartResponse = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not add to cart");
  return data;
}

export function AddToCartButton({
  productId,
  stock,
  quantity = 1,
  size = "default",
  className,
  label = "Add to Cart",
  showIcon = true,
}: {
  productId: string;
  stock: number;
  quantity?: number;
  size?: "sm" | "default" | "lg";
  className?: string;
  label?: string;
  showIcon?: boolean;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const router = useRouter();

  if (stock <= 0) {
    return (
      <Button variant="secondary" disabled className={cn("w-full", className)} size={size}>
        Out of Stock
      </Button>
    );
  }

  async function onAdd() {
    setState("loading");
    try {
      const data = await addToCartApi(productId, quantity);
      window.dispatchEvent(
        new CustomEvent("cart:updated", { detail: { itemCount: data.cart?.itemCount ?? 0 } })
      );
      setState("done");
      toast.success("Added to cart", {
        action: { label: "View Cart", onClick: () => router.push("/cart") },
      });
      setTimeout(() => setState("idle"), 1600);
    } catch (e) {
      setState("idle");
      toast.error(e instanceof Error ? e.message : "Could not add to cart");
    }
  }

  return (
    <Button
      type="button"
      onClick={onAdd}
      disabled={state === "loading"}
      size={size}
      className={cn("w-full gap-2", className)}
      aria-label={`${label} — ${stock} in stock`}
    >
      {state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : state === "done" ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : showIcon ? (
        <ShoppingCart className="h-4 w-4" aria-hidden="true" />
      ) : null}
      {state === "done" ? "Added!" : label}
    </Button>
  );
}

export function BuyNowButton({
  productId,
  stock,
  quantity = 1,
  size = "default",
  className,
}: {
  productId: string;
  stock: number;
  quantity?: number;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  if (stock <= 0) {
    return (
      <Button variant="outline" disabled className={cn("w-full", className)} size={size}>
        Out of Stock
      </Button>
    );
  }

  async function onBuyNow() {
    setLoading(true);
    try {
      const data = await addToCartApi(productId, quantity);
      window.dispatchEvent(
        new CustomEvent("cart:updated", { detail: { itemCount: data.cart?.itemCount ?? 0 } })
      );
      router.push("/checkout");
    } catch (e) {
      setLoading(false);
      toast.error(e instanceof Error ? e.message : "Could not start checkout");
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={onBuyNow}
      disabled={loading}
      size={size}
      className={cn("w-full gap-2 border-primary/50 text-primary hover:bg-primary/5", className)}
      aria-label="Buy now — go straight to checkout"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Zap className="h-4 w-4" aria-hidden="true" />}
      Buy Now
    </Button>
  );
}
