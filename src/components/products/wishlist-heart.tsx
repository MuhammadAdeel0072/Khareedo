"use client";

// Wishlist heart toggle (FR-05) — registered customers only; prompts guests to sign in.
import { useState, useTransition } from "react";
import { Heart } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function WishlistHeart({
  productId,
  initialWished,
  isSignedIn,
  className,
}: {
  productId: string;
  initialWished: boolean;
  isSignedIn: boolean;
  className?: string;
}) {
  const [wished, setWished] = useState(initialWished);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function onToggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!isSignedIn) {
      toast.info("Sign in to save items to your wishlist", {
        action: { label: "Sign In", onClick: () => router.push("/login") },
      });
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/wishlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not update wishlist");
        setWished(data.added);
        toast.success(data.added ? "Added to your wishlist" : "Removed from your wishlist");
      } catch {
        toast.error("Could not update wishlist. Please try again.");
      }
    });
  }

  if (!isSignedIn) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Add to wishlist"
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full bg-background/90 shadow-sm transition-colors hover:text-destructive",
          className
        )}
      >
        <Heart className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={wished ? "In your wishlist — click to remove" : "Add to wishlist"}
      aria-pressed={wished}
      disabled={pending}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-full bg-background/90 shadow-sm transition-colors hover:text-destructive disabled:opacity-60",
        wished && "text-destructive",
        className
      )}
    >
      <Heart className={cn("h-4 w-4", wished && "fill-destructive")} aria-hidden="true" />
    </button>
  );
}
