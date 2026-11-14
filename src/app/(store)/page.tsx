// Homepage — hero, side promos, categories, trust, featured, new arrivals, promotions (FR-12).
import Image from "next/image";
import Link from "next/link";
import { BannerImage } from "@/components/home/banner-image";
import { ArrowRight, Sparkles } from "lucide-react";
import { HeroCarousel } from "@/components/home/hero-carousel";
import { ProductCard } from "@/components/products/product-card";
import { Button } from "@/components/ui/button";
import { getActiveBanners } from "@/services/banners.service";
import { getCategoriesWithCounts } from "@/services/categories.service";
import { getHomepageCatalog } from "@/services/products.service";
import { describePromotion } from "@/services/promotions.service";
import { getWishlistProductIds } from "@/services/wishlist.service";
import { getSessionUser } from "@/lib/auth-guard";
import { after } from "next/server";
import {
  getPerformanceRequestId,
  isPerformanceLoggingEnabled,
  withPerformanceMeasurement,
} from "@/lib/performance-timing";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const requestId = getPerformanceRequestId();
  const startedAt = performance.now();
  if (isPerformanceLoggingEnabled) {
    after(() => {
      const durationMs = Math.round(performance.now() - startedAt);
      if (durationMs >= 1_000) {
        console.warn(
          `[performance:slow] operation=homepage.response durationMs=${durationMs}`
        );
      }
    });
  }

  return withPerformanceMeasurement(
    "homepage.component",
    () => renderHomePage(requestId),
    requestId
  );
}

async function renderHomePage(requestId: string) {
  // Wishlist depends only on the verified user, not on the public catalogue reads.
  const personalization = withPerformanceMeasurement(
    "homepage.session-user",
    getSessionUser,
    requestId
  ).then(async (user) => ({
    user,
    wishlistIds: await withPerformanceMeasurement(
      "homepage.wishlist",
      () => user ? getWishlistProductIds(user.id) : [],
      requestId
    ),
  }));

  const [heroBanners, sideBanners, categories, { featured, newArrivals, promotions }, { user, wishlistIds }] =
    await withPerformanceMeasurement("homepage.data-fetch", () => Promise.all([
      withPerformanceMeasurement(
        "homepage.banners.hero",
        () => getActiveBanners("HERO", 3),
        requestId
      ),
      withPerformanceMeasurement(
        "homepage.banners.side",
        () => getActiveBanners("SIDE", 2),
        requestId
      ),
      withPerformanceMeasurement(
        "homepage.categories",
        getCategoriesWithCounts,
        requestId
      ),
      withPerformanceMeasurement(
        "homepage.catalog",
        getHomepageCatalog,
        requestId
      ),
      personalization,
    ]), requestId);

  return (
    <div className="pb-14">
      {/* Single page-level h1 (hero slide titles are h2 — multiple h1s per page hurt a11y/SEO) */}
      <h1 className="sr-only">Khareedo — Everyday essentials. Better choices.</h1>
      {/* Hero + side promos */}
      <section className="container-khd mt-4 lg:mt-6" aria-label="Featured promotions">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <HeroCarousel
              banners={heroBanners.map((b) => ({
                id: b.id,
                title: b.title,
                subtitle: b.subtitle,
                imageUrl: b.imageUrl,
                linkUrl: b.linkUrl,
              }))}
            />
          </div>
          <div className="hidden gap-4 lg:grid lg:grid-rows-2">
            {sideBanners.map((b) => (
              <Link
                key={b.id}
                href={b.linkUrl ?? "/products"}
                className="group relative overflow-hidden rounded-2xl bg-cream"
              >
                <div className="relative aspect-[16/6.4] w-full lg:aspect-auto lg:h-full">
                  <BannerImage
                    src={b.imageUrl}
                    alt={b.title}
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
                  <div className="absolute bottom-0 left-0 right-0 p-5 text-white">
                    <h2 className="text-lg font-extrabold leading-snug">{b.title}</h2>
                    {b.subtitle && <p className="mt-0.5 text-xs text-white/85">{b.subtitle}</p>}
                    <span className="mt-2 inline-flex items-center gap-1 rounded-md bg-white/95 px-3 py-1.5 text-xs font-bold text-foreground transition group-hover:bg-white">
                      Shop Now <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Category circles */}
      <section className="container-khd mt-8 sm:mt-10" aria-label="Shop by category">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-10">
          {categories.map((c) => (
            <Link
              key={c.id}
              href={`/products?category=${c.slug}`}
              className="group flex flex-col items-center gap-2 rounded-xl border bg-card p-3 text-center transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
            >
              <span className="relative h-14 w-14 overflow-hidden rounded-full bg-muted sm:h-16 sm:w-16">
                <Image
                  src={c.imageUrl ?? "/images/placeholder.svg"}
                  alt={c.name}
                  fill
                  sizes="64px"
                  className="object-cover transition-transform duration-300 group-hover:scale-110"
                />
              </span>
              <span className="text-[11px] font-semibold leading-tight sm:text-xs">{c.name}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Promotions strip */}
      {promotions.length > 0 && (
        <section className="container-khd mt-8 sm:mt-10" aria-label="Current offers">
          <div className="grid gap-3 sm:grid-cols-2">
            {promotions.map((p) => (
              <div
                key={p.id}
                className="flex min-w-0 items-center gap-4 rounded-xl border border-primary/20 bg-brand-50 p-4"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold">
                    {p.title} — <span className="text-primary">{describePromotion(p)}</span>
                  </p>
                  {p.description && (
                    <p className="truncate text-xs text-muted-foreground">{p.description}</p>
                  )}
                </div>
                <Button asChild variant="ghost" size="sm" className="ml-auto shrink-0 gap-1 text-primary">
                  <Link href="/products">
                    Shop <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Featured products */}
      <section className="container-khd mt-10 sm:mt-12" aria-label="Featured products">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-extrabold tracking-tight">Featured Products</h2>
            <p className="mt-1 text-sm text-muted-foreground">Handpicked for you</p>
          </div>
          <Button asChild variant="ghost" className="gap-1 text-primary">
            <Link href="/products">
              View All <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
          {featured.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              wished={wishlistIds.includes(p.id)}
              isSignedIn={Boolean(user)}
            />
          ))}
        </div>
      </section>

      {/* New arrivals */}
      <section className="container-khd mt-10 sm:mt-12" aria-label="New arrivals">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-extrabold tracking-tight">New Arrivals</h2>
            <p className="mt-1 text-sm text-muted-foreground">Fresh picks added this week</p>
          </div>
          <Button asChild variant="ghost" className="gap-1 text-primary">
            <Link href="/products?sort=newest">
              View All <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
          {newArrivals.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              wished={wishlistIds.includes(p.id)}
              isSignedIn={Boolean(user)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
