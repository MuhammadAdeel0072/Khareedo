// Product listing with filters, sorting, pagination (FR-07..11, FR-48).
import Link from "next/link";
import { Suspense } from "react";
import { PackageSearch } from "lucide-react";
import type { Metadata } from "next";
import { ProductCard } from "@/components/products/product-card";
import { ProductFilters } from "@/components/products/product-filters";
import { MobileFilters } from "@/components/products/mobile-filters";
import { ProductSort } from "@/components/products/product-sort";
import { Skeleton } from "@/components/ui/skeleton";
import { listProducts, type ProductListItem } from "@/services/products.service";
import { getCategoriesWithCounts, getCategoryBySlug } from "@/services/categories.service";
import { getWishlistProductIds } from "@/services/wishlist.service";
import { getRequestSession, getSessionUser } from "@/lib/auth-guard";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : undefined;
  const cat = typeof params.category === "string" ? params.category : undefined;
  if (cat) {
    const category = await getCategoryBySlug(cat);
    if (category) return { title: category.name, description: category.description ?? undefined };
  }
  if (q) return { title: `Search: ${q}` };
  return { title: "Shop All Products" };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ProductsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const q = first(params.q);
  const category = first(params.category);
  const sort = first(params.sort) ?? "featured";
  const page = Number(first(params.page) ?? "1") || 1;
  const min = first(params.min);
  const max = first(params.max);
  const inStockOnly = first(params.instock) === "1";

  const userPromise = getSessionUser();
  const [result, categories, user, activeCategory, wishlistIds] = await Promise.all([
    listProducts({
      q,
      category,
      sort: sort as "featured",
      page,
      minPrice: min !== undefined ? Number(min) : undefined,
      maxPrice: max !== undefined ? Number(max) : undefined,
      inStockOnly,
      perPage: 12,
    }),
    getCategoriesWithCounts(),

    userPromise,
    category ? getCategoryBySlug(category) : Promise.resolve(null),
    // Wishlist ids ride the same batch instead of a follow-up round trip.
    userPromise.then((u) => (u ? getWishlistProductIds(u.id) : [])),
  ]);

  // Count of active filters for the mobile filter button badge
  const activeFilterCount =
    (category ? 1 : 0) + (inStockOnly ? 1 : 0) + (min !== undefined || max !== undefined ? 1 : 0);

  const buildPageUrl = (p: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      const val = first(v);
      if (val && k !== "page") next.set(k, val);
    }
    if (p > 1) next.set("page", String(p));
    return `/products?${next.toString()}`;
  };

  return (
    <div className="container-khd py-6">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link href="/">Home</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              {activeCategory ? activeCategory.name : q ? `Search: ${q}` : "Shop All"}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
          {activeCategory ? activeCategory.name : q ? `Results for "${q}"` : "Shop All Products"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {activeCategory?.description ?? "Discover premium products at everyday great prices"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        {/* Desktop sidebar filters — replaced by a bottom-sheet drawer on <lg */}
        <div className="hidden lg:block">
          <Suspense fallback={<FilterSkeleton />}>
            <ProductFilters categories={categories} totalResults={result.total} />
          </Suspense>
        </div>

        <div className="min-w-0">
          <div className="mb-4 flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{result.total}</span>{" "}
              <span className="hidden min-[400px]:inline">products found</span>
              <span className="min-[400px]:hidden">found</span>
            </p>
            <div className="flex items-center gap-2">
              <div className="lg:hidden">
                <Suspense fallback={null}>
                  <MobileFilters
                    categories={categories}
                    totalResults={result.total}
                    activeCount={activeFilterCount}
                  />
                </Suspense>
              </div>
              <Suspense fallback={null}>
                <ProductSort value={sort} />
              </Suspense>
            </div>
          </div>

          {result.items.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:gap-4 xl:grid-cols-4">
                {result.items.map((p: ProductListItem, i) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    wished={wishlistIds.includes(p.id)}
                    isSignedIn={Boolean(user)}
                    priority={i < 4}
                  />
                ))}
              </div>

              {result.pages > 1 && (
                <Pagination className="mt-8">
                  <PaginationContent>
                    {result.page > 1 && (
                      <PaginationItem>
                        <PaginationPrevious href={buildPageUrl(result.page - 1)} />
                      </PaginationItem>
                    )}
                    {Array.from({ length: Math.min(5, result.pages) }, (_, i) => {
                      const start = Math.max(1, Math.min(result.page - 2, result.pages - 4));
                      return start + i <= result.pages ? (
                        <PaginationItem key={start + i}>
                          <PaginationLink
                            href={buildPageUrl(start + i)}
                            isActive={start + i === result.page}
                          >
                            {start + i}
                          </PaginationLink>
                        </PaginationItem>
                      ) : null;
                    })}
                    {result.page < result.pages && (
                      <PaginationItem>
                        <PaginationNext href={buildPageUrl(result.page + 1)} />
                      </PaginationItem>
                    )}
                  </PaginationContent>
                </Pagination>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20 text-center">
      <PackageSearch className="h-12 w-12 text-muted-foreground/50" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-bold">No products found</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        We couldn&apos;t find any products matching your filters. Try adjusting your search or
        browsing another category.
      </p>
      <Link
        href="/products"
        className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Browse All Products
      </Link>
    </div>
  );
}

function FilterSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
}
