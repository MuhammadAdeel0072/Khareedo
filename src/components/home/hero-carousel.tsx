"use client";

// Hero banner carousel (embla) — promotional banners managed by admin (FR-12, FR-51).
import useEmblaCarousel from "embla-carousel-react";
import Autoplay from "embla-carousel-autoplay";
import { BannerImage } from "@/components/home/banner-image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface HeroBanner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  linkUrl: string | null;
}

export function HeroCarousel({ banners }: { banners: HeroBanner[] }) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true }, [
    Autoplay({ delay: 6000, stopOnInteraction: false, stopOnMouseEnter: true }),
  ]);
  const [selected, setSelected] = useState(0);

  const onSelect = useCallback(() => {
    if (emblaApi) setSelected(emblaApi.selectedScrollSnap());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.on("select", onSelect);
  }, [emblaApi, onSelect]);

  if (banners.length === 0) return null;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-cream" ref={emblaRef}>
      <div className="flex">
        {banners.map((b, index) => (
          <div key={b.id} className="relative min-w-0 flex-[0_0_100%]">
            {/* Min-height floors guarantee the text stack + CTA always fit inside the box
                (fixed aspect alone clipped the eyebrow at top and Shop Now at bottom). */}
            <div className="relative aspect-[4/3] w-full min-h-[264px] sm:aspect-[2/1] sm:min-h-[360px] lg:aspect-[2.55/1] lg:min-h-[440px]">
              <BannerImage
                src={b.imageUrl}
                alt={b.title}
                eager={index === 0}
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-cream via-cream/80 to-transparent sm:via-cream/40" />
              <div className="absolute inset-0 flex flex-col justify-center p-6 sm:p-10 lg:p-12">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary/80">
                  Premium products for your everyday life
                </p>
                <h2 className="mt-2 max-w-md text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl lg:max-w-lg lg:text-5xl">
                  {b.title}
                </h2>
                {b.subtitle && (
                  <p className="mt-2 hidden max-w-sm text-sm text-muted-foreground sm:block sm:text-base">
                    {b.subtitle}
                  </p>
                )}
                {/* CTA always renders — linkUrl falls back to the catalogue (was conditionally hidden). */}
                <Button size="lg" className="mt-4 w-fit gap-2 sm:mt-6" asChild>
                  <Link href={b.linkUrl ?? "/products"}>
                    Shop Now <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {banners.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => emblaApi?.scrollPrev()}
            aria-label="Previous banner"
            className="absolute left-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 shadow-md transition hover:bg-background sm:flex"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => emblaApi?.scrollNext()}
            aria-label="Next banner"
            className="absolute right-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 shadow-md transition hover:bg-background sm:flex"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1.5" role="tablist" aria-label="Banner slides">
            {banners.map((b, i) => (
              <button
                key={b.id}
                type="button"
                role="tab"
                aria-selected={selected === i}
                aria-label={`Go to banner ${i + 1}`}
                onClick={() => emblaApi?.scrollTo(i)}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  selected === i ? "w-6 bg-primary" : "w-1.5 bg-primary/30 hover:bg-primary/50"
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
