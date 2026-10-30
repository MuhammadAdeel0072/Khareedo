"use client";

// Search box — submits to /products?q= (FR-09).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SearchBar({ className }: { className?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      role="search"
      className={`relative flex w-full ${className ?? ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        router.push(q.trim() ? `/products?q=${encodeURIComponent(q.trim())}` : "/products");
        setPending(false);
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
        className="h-11 rounded-l-md rounded-r-none border-r-0 pl-10 text-sm"
      />
      <Button
        type="submit"
        disabled={pending}
        className="h-11 rounded-l-none rounded-r-md px-5"
        aria-label="Search"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
      </Button>
    </form>
  );
}
