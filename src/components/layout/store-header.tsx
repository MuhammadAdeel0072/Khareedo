// Store header — announcement bar, main header (logo/search/account/wishlist/cart),
// and category navigation bar. Server component: data fetched from services (FR-33, FR-47).
import Link from "next/link";
import { Heart, ShoppingCart, Truck, ShieldCheck, RotateCcw, Lock, Headset } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { SearchBar } from "@/components/layout/search-bar";
import { UserMenu } from "@/components/layout/user-menu";
import { CartCountBadge } from "@/components/cart/cart-count-badge";
import { WhatsAppIcon } from "@/components/layout/whatsapp-icon";
import { getCategoryTree, type CategoryNode } from "@/services/categories.service";
import type { StoreSettings } from "@/services/settings.service";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { getCartCount } from "@/services/cart.service";
import { getRequestSession } from "@/lib/auth-guard";
import { formatPKR } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  getPerformanceRequestId,
  withPerformanceMeasurement,
  withPerformanceTiming,
} from "@/lib/performance-timing";

export async function StoreHeader({ settings }: { settings: StoreSettings }) {
  const requestId = getPerformanceRequestId();
  return withPerformanceTiming("page.store-header", async () => {
    const [categories, session, cartCount] = await Promise.all([
      withPerformanceMeasurement(
        "homepage.header.categories",
        getCategoryTree,
        requestId
      ),
      withPerformanceMeasurement(
        "homepage.header.session",
        getRequestSession,
        requestId
      ),
      withPerformanceMeasurement(
        "homepage.header.cart-count",
        getCartCount,
        requestId
      ),
    ]);

    return (
      <>
      {/* Announcement / trust bar — intentionally OUTSIDE the sticky header so it scrolls
          away, keeping the persistent mobile chrome compact (main header + search + chips) */}
      <div className="bg-brand-dark text-primary-foreground">
        <div className="trust-marquee-viewport text-[12px]" aria-label="Store announcements and assurances">
          <div className="trust-marquee-track flex w-max items-center">
            <TrustMarqueeItems settings={settings} />
            <TrustMarqueeItems settings={settings} aria-hidden={true} />
          </div>
        </div>
      </div>

      {/* Main header — sticky */}
      <header className="sticky top-0 z-50 w-full">
        <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="container-khd flex h-16 items-center gap-4 lg:gap-8">
            <Logo />
            <div className="hidden flex-1 md:block">
              <SearchBar className="mx-auto max-w-2xl" />
            </div>
            <div className="ml-auto flex items-center gap-1 md:gap-2">
              <UserMenu
                name={session?.user?.name}
                email={session?.user?.email}
                role={session?.user?.role}
              />
              <Link
                href="/account/wishlist"
                className="relative flex h-11 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-muted-foreground transition-colors hover:text-primary"
              >
                <Heart className="h-5 w-5" aria-hidden="true" />
                <span className="text-[11px] font-medium max-[399px]:sr-only">Wishlist</span>
              </Link>
              <Link
                href="/cart"
                className="relative flex h-11 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-muted-foreground transition-colors hover:text-primary"
              >
                <span className="relative">
                  <ShoppingCart className="h-5 w-5" aria-hidden="true" />
                  <CartCountBadge initialCount={cartCount} />
                </span>
                <span className="text-[11px] font-medium max-[399px]:sr-only">Cart</span>
              </Link>
            </div>
          </div>
          <div className="container-khd pb-3 md:hidden">
            <SearchBar />
          </div>
        </div>

        {/* Category navigation */}
        <CategoryNav categories={categories} />
      </header>
      </>
    );
  }, requestId);
}

function TrustMarqueeItems({
  settings,
  ...props
}: {
  settings: StoreSettings;
  "aria-hidden"?: true;
}) {
  return (
    <div {...props} className="flex shrink-0 items-center gap-7 whitespace-nowrap px-4 sm:gap-9 sm:px-6">
      <p className="flex items-center gap-1.5">
        <Truck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{settings.announcement_text || "Free Delivery on Orders Above Rs 3,000"}</span>
      </p>
      <span className="flex items-center gap-1">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> 100% Original Products
      </span>
      <span className="flex items-center gap-1">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Easy Returns
      </span>
      <span className="flex items-center gap-1">
        <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Secure Payments
      </span>
      <Link href="/contact" className="flex items-center gap-1 hover:underline">
        <Headset className="h-3.5 w-3.5" aria-hidden="true" />
        Need Help?
      </Link>
      <a
        href={whatsappHref(settings.whatsapp_number, genericMessage(settings.store_name))}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 font-medium hover:underline"
      >
        <WhatsAppIcon className="h-3.5 w-3.5" />
        WhatsApp Us
      </a>
    </div>
  );
}

function CategoryNav({ categories }: { categories: CategoryNode[] }) {
  return (
    <>
      {/* Desktop category bar */}
      <nav aria-label="Product categories" className="hidden border-b bg-background shadow-sm lg:block">
        <div className="container-khd">
          <ul className="flex h-11 items-center gap-1 text-[13.5px] font-medium text-foreground/80">
            <li>
              <Link href="/" className="rounded-md bg-accent px-3 py-1.5 text-accent-foreground">
                Home
              </Link>
            </li>
            <li>
              <Link href="/products" className="rounded-md px-3 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground">
                Shop All
              </Link>
            </li>
            {categories.map((cat) => (
              <li key={cat.id}>
                {cat.children.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-3 py-1.5 outline-none transition-colors hover:bg-accent hover:text-accent-foreground">
                      {cat.name}
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <DropdownMenuItem asChild>
                        <Link href={`/products?category=${cat.slug}`}>All {cat.name}</Link>
                      </DropdownMenuItem>
                      {cat.children.map((child) => (
                        <DropdownMenuItem key={child.id} asChild>
                          <Link href={`/products?category=${child.slug}`}>{child.name}</Link>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Link
                    href={`/products?category=${cat.slug}`}
                    className="rounded-md px-3 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {cat.name}
                  </Link>
                )}
              </li>
            ))}
            <li className="ml-auto">
              <Link
                href="/products?sort=price-asc"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-destructive transition-colors hover:bg-destructive/10"
              >
                Sale
                <span className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                  Hot
                </span>
              </Link>
            </li>
          </ul>
        </div>
      </nav>

      {/* Mobile / tablet category chips — horizontal scroll, larger touch targets */}
      <nav
        aria-label="Product categories"
        className="overflow-x-auto border-b bg-background shadow-sm [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden"
      >
        <ul className="flex w-max items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-foreground/80">
          <li>
            <Link href="/products" className="block whitespace-nowrap rounded-full bg-primary px-4 py-2 text-primary-foreground">
              Shop All
            </Link>
          </li>
          {categories.map((cat) => (
            <li key={cat.id}>
              <Link
                href={`/products?category=${cat.slug}`}
                className="block whitespace-nowrap rounded-full border bg-card px-4 py-2 transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {cat.name}
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/products?sort=price-asc"
              className="block whitespace-nowrap rounded-full border border-destructive/30 bg-destructive/5 px-4 py-2 text-destructive"
            >
              Sale
            </Link>
          </li>
        </ul>
      </nav>
    </>
  );
}

// ─── WhatsApp helpers (client-side URL builders duplicated for RSC use) ───
function whatsappHref(number: string, message: string): string {
  return `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
}
function genericMessage(storeName: string): string {
  return `Hello ${storeName}! I need some assistance with my shopping.`;
}
