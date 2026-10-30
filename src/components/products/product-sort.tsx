"use client";

// Sort dropdown (FR-11) — URL-param driven.
import { useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SORTS = [
  { value: "featured", label: "Featured" },
  { value: "newest", label: "Newest First" },
  { value: "price-asc", label: "Price: Low to High" },
  { value: "price-desc", label: "Price: High to Low" },
  { value: "rating", label: "Top Rated" },
];

export function ProductSort({ value }: { value: string }) {
  const router = useRouter();
  const params = useSearchParams();

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="hidden text-muted-foreground sm:inline">Sort by:</span>
      <Select
        value={value}
        onValueChange={(v) => {
          const next = new URLSearchParams(params.toString());
          if (v === "featured") next.delete("sort");
          else next.set("sort", v);
          next.delete("page");
          router.push(`/products?${next.toString()}`, { scroll: false });
        }}
      >
        <SelectTrigger className="h-10 w-[128px] sm:w-44" aria-label="Sort products">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORTS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
