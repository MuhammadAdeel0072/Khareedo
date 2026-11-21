"use client";

// Search box — submits to /products?q= (FR-09).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SearchBar({ className }: { className?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  // The button never showed a pending state (Phase 3, chunk 12
  // follow-up B): setPending(true) was immediately followed by
  // setPending(false) in the same synchronous handler, so the state
  // never rendered. A transition keeps `isPending` true until the
  // navigation actually completes.
  const [isPending, startTransition] = useTransition();

  return (
    <form
      role="search"
      className={`relative flex min-w-0 w-full ${className ?? ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(() => {
          router.push(q.trim() ? `/products?q=${encodeURIComponent(q.trim())}` : "/products");
        });
      }}
    >
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search watches, earbuds, bags, perfumes..."
        aria-label="Search products"
        className="h-11 min-w-0 flex-1 rounded-l-md rounded-r-none border-r-0 pl-10 text-sm"
      />
      <Button
        type="submit"
        disabled={isPending}
        className="h-11 shrink-0 rounded-l-none rounded-r-md px-4 sm:px-5"
        aria-label="Search"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Search className="h-4 w-4" aria-hidden="true" />
        )}
      </Button>
    </form>
  );
}
