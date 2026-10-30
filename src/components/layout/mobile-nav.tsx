"use client";

// Mobile bottom navigation — thumb-reachable primary destinations (Home / Shop / Cart /
// Account). Fixed to the viewport bottom on <lg screens; hidden on routes that render
// their own dedicated sticky action bar (product detail, cart) to avoid double chrome.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutGrid, ShoppingCart, User } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  {
    href: "/",
    label: "Home",
    icon: Home,
    isActive: (p: string) => p === "/",
  },
  {
    href: "/products",
    label: "Shop",
    icon: LayoutGrid,
    isActive: (p: string) => p.startsWith("/products") || p.startsWith("/categories") || p.startsWith("/product"),
  },
  {
    href: "/cart",
    label: "Cart",
    icon: ShoppingCart,
    isActive: (p: string) => p.startsWith("/cart"),
  },
  {
    href: "/account",
    label: "Account",
    icon: User,
    isActive: (p: string) =>
      p.startsWith("/account") || p.startsWith("/order") || p.startsWith("/login") || p.startsWith("/register"),
  },
];

export function MobileNav() {
  const pathname = usePathname();

  // Product detail and cart pages render dedicated sticky action bars instead.
  if (pathname.startsWith("/product/") || pathname.startsWith("/cart")) return null;

  return (
    <>
      <div className="h-[calc(4rem+env(safe-area-inset-bottom))] lg:hidden" aria-hidden="true" />
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90 lg:hidden"
      >
        <ul className="grid grid-cols-4">
          {ITEMS.map((item) => {
            const active = item.isActive(pathname);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground active:text-primary"
                  )}
                >
                  {active && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-primary" aria-hidden="true" />}
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        {/* Safe-area inset for notched devices */}
        <div className="h-[env(safe-area-inset-bottom)]" aria-hidden="true" />
      </nav>
    </>
  );
}
