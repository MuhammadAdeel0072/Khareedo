"use client";

// Product gallery + quantity selector (FR-08) with thumbnails and zoom hover.
import Image from "next/image";
import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function ProductGallery({
  images,
  name,
}: {
  images: Array<{ url: string; alt: string | null }>;
  name: string;
}) {
  const [active, setActive] = useState(0);
  const imgs = images.length > 0 ? images : [{ url: "/images/placeholder.svg", alt: name }];

  return (
    <div className="space-y-3">
      <div className="group relative aspect-square overflow-hidden rounded-xl border bg-muted/30">
        <Image
          key={imgs[active].url}
          src={imgs[active].url}
          alt={imgs[active].alt ?? name}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover transition-transform duration-300 group-hover:scale-105"
        />
      </div>
      {imgs.length > 1 && (
        <div className="grid grid-cols-5 gap-2" role="tablist" aria-label="Product images">
          {imgs.map((img, i) => (
            <button
              key={img.url}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-label={`View image ${i + 1}`}
              onClick={() => setActive(i)}
              className={cn(
                "relative aspect-square overflow-hidden rounded-lg border-2 transition",
                i === active ? "border-primary" : "border-transparent hover:border-muted-foreground/30"
              )}
            >
              <Image src={img.url} alt="" fill sizes="80px" className="object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function QuantitySelector({
  value,
  onChange,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  max: number;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border" role="group" aria-label="Quantity">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-10 w-10"
        onClick={() => onChange(Math.max(1, value - 1))}
        disabled={value <= 1}
        aria-label="Decrease quantity"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <span
        aria-live="polite"
        aria-label={`Quantity: ${value}`}
        className="w-10 text-center text-sm font-semibold tabular-nums"
      >
        {value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-10 w-10"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label="Increase quantity"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
