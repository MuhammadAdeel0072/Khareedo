// Product details page (FR-08, FR-13) — gallery, price, stock, add to cart, wishlist,
// WhatsApp inquiry for this product (FR-35), related products.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ChevronRight, ShieldCheck, Truck, RotateCcw, PackageCheck } from "lucide-react";
import { ProductGallery } from "@/components/products/product-gallery";
import { ProductCard } from "@/components/products/product-card";
import { RatingStars } from "@/components/products/rating-stars";
import { WishlistHeart } from "@/components/products/wishlist-heart";
import { PdpActions } from "@/components/products/pdp-actions";
import { WhatsAppIcon } from "@/components/layout/whatsapp-icon";
import {
  getProductBySlug,
  getProductMetadataBySlug,
  getRelatedProducts,
} from "@/services/products.service";
import { getCachedSettings } from "@/services/settings.service";
import { getRequestSession, getSessionUser } from "@/lib/auth-guard";
import { getWishlistProductIds } from "@/services/wishlist.service";
import { discountPercent, formatPKR } from "@/lib/utils";
import { buildProductInquiryMessage } from "@/lib/whatsapp-messages";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { withPerformanceTiming } from "@/lib/performance-timing";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  return withPerformanceTiming("page.product-metadata", async () => {
    const { slug } = await params;
    const product = await getProductMetadataBySlug(slug);
    if (!product) return { title: "Product Not Found" };
    return {
      title: product.name,
      description: product.description.slice(0, 160),
      openGraph: { images: product.images[0] ? [product.images[0].url] : undefined },
    };
  });
}

export default async function ProductPage({ params }: PageProps) {
  return withPerformanceTiming("page.product-details", async () => {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const userPromise = getSessionUser();
  const [settings, related, session, user, wishlistIds] = await Promise.all([
    getCachedSettings(),
    getRelatedProducts(product.category.id, product.id, 4),
    getRequestSession(),
    userPromise,
    // Wishlist ids ride the same batch instead of a follow-up round trip.
    userPromise.then((u) => (u ? getWishlistProductIds(u.id) : [])),
  ]);

  const off = discountPercent(product.price, product.comparePrice);
  const lowStock = product.stock > 0 && product.stock <= product.lowStockThreshold;

  const waHref = `https://wa.me/${settings.whatsapp_number.replace(/\D/g, "")}?text=${encodeURIComponent(
    buildProductInquiryMessage(settings.store_name, product.name, product.price)
  )}`;

  return (
    <div className="container-khd py-6">
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink asChild><Link href="/">Home</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink asChild><Link href="/products">Shop</Link></BreadcrumbLink></BreadcrumbItem>
          {product.category.parentName && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href={`/products?category=${product.category.slug}`}>{product.category.name}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
            </>
          )}
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-40 truncate">{product.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <ProductGallery images={product.images} name={product.name} />

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {product.brand ?? product.category.name}
          </p>
          <div className="mt-1 flex items-start justify-between gap-3">
            <h1 className="text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">
              {product.name}
            </h1>
            <WishlistHeart
              productId={product.id}
              initialWished={wishlistIds.includes(product.id)}
              isSignedIn={Boolean(user)}
              className="h-10 w-10 shrink-0 border"
            />
          </div>

          <div className="mt-2 flex items-center gap-3">
            <RatingStars rating={product.rating} reviewCount={product.reviewCount} size="md" />
            <span className="text-sm text-muted-foreground">·</span>
            <span className="text-sm text-muted-foreground">
              {product.stock > 0 ? `${product.stock} in stock` : "Currently unavailable"}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-extrabold text-primary">{formatPKR(product.price)}</span>
            {product.comparePrice && product.comparePrice > product.price && (
              <>
                <span className="text-lg text-muted-foreground line-through">
                  {formatPKR(product.comparePrice)}
                </span>
                {off !== null && (
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-sm font-bold text-primary">
                    Save {off}%
                  </span>
                )}
              </>
            )}
          </div>

          {product.stock > 0 && (
            <p className={`mt-2 flex items-center gap-1.5 text-sm ${lowStock ? "font-medium text-amber-600" : "text-emerald-600"}`}>
              <PackageCheck className="h-4 w-4" aria-hidden="true" />
              {lowStock ? `Hurry — only ${product.stock} left in stock` : "In stock and ready to ship"}
            </p>
          )}

          <Separator className="my-5" />

          <p className="text-sm leading-7 text-foreground/85">{product.description}</p>

          {product.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {product.tags.map((t) => (
                <Link
                  key={t}
                  href={`/products?q=${encodeURIComponent(t)}`}
                  className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  {t}
                </Link>
              ))}
            </div>
          )}

          <PdpActions productId={product.id} stock={product.stock} price={product.price} />

          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 hidden h-11 w-full items-center justify-center gap-2 rounded-md border border-[#25D366]/40 text-sm font-medium text-[#128C4B] transition-colors hover:bg-[#25D366]/10 lg:flex"
          >
            <WhatsAppIcon className="h-4 w-4" />
            Ask about this product on WhatsApp
          </a>

          <div className="mt-6 grid grid-cols-3 gap-3 rounded-xl border bg-muted/40 p-4 text-center text-xs">
            <div className="flex flex-col items-center gap-1.5">
              <Truck className="h-5 w-5 text-primary" aria-hidden="true" />
              <span className="font-medium">Fast Delivery</span>
              <span className="text-muted-foreground">2-5 working days</span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
              <span className="font-medium">COD Available</span>
              <span className="text-muted-foreground">Pay on delivery</span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <RotateCcw className="h-5 w-5 text-primary" aria-hidden="true" />
              <span className="font-medium">Easy Returns</span>
              <span className="text-muted-foreground">Within 7 days</span>
            </div>
          </div>

          {product.sku && (
            <p className="mt-4 text-xs text-muted-foreground">SKU: {product.sku}</p>
          )}
        </div>
      </div>

      {related.length > 0 && (
        <section className="mt-14" aria-label="Related products">
          <div className="mb-5 flex items-end justify-between">
            <h2 className="text-xl font-extrabold tracking-tight">You May Also Like</h2>
            <Link
              href={`/products?category=${product.category.slug}`}
              className="flex items-center gap-0.5 text-sm font-medium text-primary hover:underline"
            >
              View all <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:gap-4">
            {related.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                wished={wishlistIds.includes(p.id)}
                isSignedIn={Boolean(user)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
    );
  });
}
