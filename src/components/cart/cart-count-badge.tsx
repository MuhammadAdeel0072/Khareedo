"use client";

// Cart count badge — hydrates from server, refreshes via /api/cart on
// "cart:updated" window events dispatched by cart mutations (FR-04 immediate feedback).
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function CartCountBadge({
  initialCount,
  className,
}: {
  initialCount: number;
  className?: string;
}) {
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    const onCartUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ itemCount?: number }>).detail;
      if (typeof detail?.itemCount === "number") setCount(detail.itemCount);
    };
    window.addEventListener("cart:updated", onCartUpdated);
    return () => window.removeEventListener("cart:updated", onCartUpdated);
  }, []);

  if (count <= 0) return null;
  return (
    <span
      aria-live="polite"
      className={cn(
        "absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground shadow",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
