"use client";

// Listing sidebar filters — category, brand, price, availability (FR-10). URL-param driven.
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatPKR } from "@/lib/utils";

export interface FilterCategory {
  name: string;
  slug: string;
  productCount: number;
}

const PRICE_MIN = 0;
/** Fallback cap when the page does not supply the data-driven catalogue max. */
const DEFAULT_PRICE_MAX = 50000;

export function ProductFilters({
  categories,
  brands = [],
  maxPrice = DEFAULT_PRICE_MAX,
  totalResults,
}: {
  categories: FilterCategory[];
  brands?: string[];
  maxPrice?: number;
  totalResults: number;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const activeCategory = params.get("category") ?? "";
  const activeBrand = params.get("brand") ?? "";
  const activeMin = params.get("min") ?? String(PRICE_MIN);
  const activeMax = params.get("max") ?? String(maxPrice);
  const inStockOnly = params.get("instock") === "1";

  const [priceRange, setPriceRange] = useState<[number, number]>([
    Math.min(Number(activeMin) || PRICE_MIN, maxPrice),
    Math.min(Number(activeMax) || maxPrice, maxPrice),
  ]);

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      next.delete("page"); // filters reset pagination
      router.push(`/products?${next.toString()}`, { scroll: false });
    },
    [params, router]
  );

  const applyPrice = () => {
    setParam({
      min: priceRange[0] > PRICE_MIN ? String(priceRange[0]) : null,
      max: priceRange[1] < maxPrice ? String(priceRange[1]) : null,
    });
  };

  // A filter counts as active only when it actually narrows the listing.
  // (The min/max params default to the full range, so comparing them
  // against null was always true and "Clear all filters" never hid.)
  const hasFilters =
    activeCategory !== "" ||
    activeBrand !== "" ||
    inStockOnly ||
    Number(activeMin) > PRICE_MIN ||
    Number(activeMax) < maxPrice;

  return (
    <aside aria-label="Product filters" className="space-y-5">
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="text-primary"
          onClick={() => router.push("/products")}
        >
          Clear all filters
        </Button>
      )}

      <section className="rounded-xl border p-4">
        <h3 className="mb-3 text-sm font-bold">Categories</h3>
        <ul className="space-y-2.5">
          {categories.map((c) => (
            <li key={c.slug}>
              <Label
                className="flex cursor-pointer items-center justify-between gap-2 text-sm font-normal"
                onClick={() => setParam({ category: activeCategory === c.slug ? null : c.slug })}
              >
                <span className="flex items-center gap-2">
                  <Checkbox checked={activeCategory === c.slug} aria-hidden="true" tabIndex={-1} />
                  <span className={activeCategory === c.slug ? "font-semibold text-primary" : ""}>
                    {c.name}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">({c.productCount})</span>
              </Label>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border p-4">
        <h3 className="mb-3 text-sm font-bold">Price Range</h3>
        <Slider
          min={PRICE_MIN}
          max={maxPrice}
          step={500}
          value={priceRange}
          onValueChange={(v) => setPriceRange(v as [number, number])}
          aria-label="Price range"
          className="mb-3"
        />
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{formatPKR(priceRange[0])}</span>
          <span>to</span>
          <span>{priceRange[1] >= maxPrice ? `${formatPKR(maxPrice)}+` : formatPKR(priceRange[1])}</span>
        </div>
        <Button size="sm" className="mt-3 w-full" onClick={applyPrice}>
          Apply Price
        </Button>
      </section>

      {brands.length > 0 && (
        <section className="rounded-xl border p-4">
          <h3 className="mb-3 text-sm font-bold">Brands</h3>
          <ul className="space-y-2.5">
            {brands.map((brand) => (
              <li key={brand}>
                <Label
                  className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                  onClick={() => setParam({ brand: activeBrand === brand ? null : brand })}
                >
                  <Checkbox checked={activeBrand === brand} aria-hidden="true" tabIndex={-1} />
                  <span className={activeBrand === brand ? "font-semibold text-primary" : ""}>
                    {brand}
                  </span>
                </Label>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border p-4">
        <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
          <Checkbox
            checked={inStockOnly}
            onCheckedChange={(checked) => setParam({ instock: checked ? "1" : null })}
          />
          In stock only
        </Label>
      </section>

      <p className="text-center text-xs text-muted-foreground">
        {totalResults} product{totalResults === 1 ? "" : "s"} found
      </p>
    </aside>
  );
}
