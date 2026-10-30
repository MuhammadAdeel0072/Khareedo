"use client";

// Mobile filter drawer — the desktop sidebar becomes a bottom sheet on <lg screens so
// products appear immediately (previously the full filter stack pushed them far down).
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ProductFilters, type FilterCategory } from "@/components/products/product-filters";

export function MobileFilters({
  categories,
  totalResults,
  activeCount,
}: {
  categories: FilterCategory[];
  totalResults: number;
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        className="h-10 gap-1.5 px-3"
        aria-label={`Filters${activeCount > 0 ? ` — ${activeCount} active` : ""}`}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        <span className="hidden min-[400px]:inline">Filters</span>
        {activeCount > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {activeCount}
          </span>
        )}
      </Button>
      <SheetContent
        side="bottom"
        className="flex max-h-[85dvh] flex-col rounded-t-2xl px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-0 sm:max-h-[85vh]"
      >
        <SheetHeader className="border-b px-0 pb-3 pt-4 text-left">
          <SheetTitle className="text-base font-bold">Filters</SheetTitle>
          <SheetDescription className="sr-only">
            Refine products by category, price and availability
          </SheetDescription>
        </SheetHeader>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-4 thin-scrollbar">
          <ProductFilters categories={categories} totalResults={totalResults} />
        </div>
        <div className="border-t pt-3">
          <Button className="h-11 w-full text-base" onClick={() => setOpen(false)}>
            Show {totalResults} product{totalResults === 1 ? "" : "s"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
