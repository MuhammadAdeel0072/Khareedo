// Product card — image, badges, name, price, rating, wishlist, add-to-cart (FR-47/FR-12).
import Link from "next/link";
import Image from "next/image";
import { discountPercent, formatPKR } from "@/lib/utils";
import { RatingStars } from "@/components/products/rating-stars";
import { WishlistHeart } from "@/components/products/wishlist-heart";
import { AddToCartButton } from "@/components/cart/add-to-cart-button";
import { Badge } from "@/components/ui/badge";
import type { ProductListItem } from "@/services/products.service";
import { cn } from "@/lib/utils";

const FALLBACK_IMAGE = "/images/placeholder.svg";

export function ProductCard({
  product,
  wished = false,
  isSignedIn = false,
  priority = false,
}: {
  product: ProductListItem;
  wished?: boolean;
  isSignedIn?: boolean;
  priority?: boolean;
}) {
  const off = discountPercent(product.price, product.comparePrice);
  const isNew = Date.now() - new Date(product.createdAt).getTime() < 1000 * 60 * 60 * 24 * 14;
  const out = product.stock <= 0;

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-xl border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
      <Link
        href={`/product/${product.slug}`}
        className="relative block aspect-square overflow-hidden bg-muted/40"
        aria-label={product.name}
      >
        <Image
          src={product.image || FALLBACK_IMAGE}
          alt={product.name}
          fill
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
          priority={priority}
          className="object-cover transition-transform duration-300 group-hover:scale-105"
        />
        <div className="absolute left-2.5 top-2.5 flex flex-col gap-1.5">
          {off !== null && (
            <Badge className="bg-primary text-primary-foreground">{off}% OFF</Badge>
          )}
          {isNew && off === null && (
            <Badge variant="secondary" className="bg-card/95">
              New
            </Badge>
          )}
          {out && <Badge variant="destructive">Out of Stock</Badge>}
        </div>
      </Link>

      <WishlistHeart
        productId={product.id}
        initialWished={wished}
        isSignedIn={isSignedIn}
        className="absolute right-2.5 top-2.5"
      />

      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {product.brand ?? product.categoryName}
        </p>
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
          <Link href={`/product/${product.slug}`} className="hover:text-primary">
            {product.name}
          </Link>
        </h3>
        <RatingStars rating={product.rating} reviewCount={product.reviewCount} />
        <div className="mt-auto flex items-baseline gap-2 pt-1">
          <span className="text-base font-extrabold text-primary">{formatPKR(product.price)}</span>
          {product.comparePrice && product.comparePrice > product.price && (
            <span className="text-xs text-muted-foreground line-through">
              {formatPKR(product.comparePrice)}
            </span>
          )}
        </div>
        {out ? (
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="mt-1.5 flex h-10 w-full cursor-not-allowed items-center justify-center rounded-md bg-muted text-sm font-medium text-muted-foreground"
          >
            Out of Stock
          </button>
        ) : (
          <div className="mt-1.5">
            <AddToCartButton productId={product.id} stock={product.stock} size="sm" className={cn("h-10 text-[13px]")} />
          </div>
        )}
      </div>
    </article>
  );
}
