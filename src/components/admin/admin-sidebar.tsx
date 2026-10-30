// Admin sidebar navigation (FR-38, matches approved admin mockup design).
"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "next-auth/react";
import {
  BarChart3,
  Boxes,
  Image as ImageIcon,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Package,
  Settings,
  ShoppingCart,
  Store,
  Tags,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/products", label: "Products", icon: Package },
  { href: "/admin/categories", label: "Categories", icon: Boxes },
  { href: "/admin/orders", label: "Orders", icon: ShoppingCart },
  { href: "/admin/customers", label: "Customers", icon: Users },
  { href: "/admin/banners", label: "Banners", icon: ImageIcon },
  { href: "/admin/coupons", label: "Coupons", icon: Tags },
  { href: "/admin/promotions", label: "Promotions", icon: Megaphone },
  { href: "/admin/reports", label: "Reports", icon: BarChart3 },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminSidebar({ pendingOrders }: { pendingOrders: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  const closeMobile = () => setMobileOpen(false);

  return (
    <aside className="flex h-full w-full flex-col bg-brand-dark text-white lg:h-screen lg:w-60 lg:shrink-0">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 lg:hidden">
        <Link href="/admin" className="flex items-center gap-2.5" onClick={closeMobile} aria-label="Khareedo admin home">
          <Image
            src="/favicon.svg"
            alt=""
            width={36}
            height={36}
            className="h-8 w-8"
          />
          <span className="text-base font-semibold">Khareedo Admin</span>
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          aria-expanded={mobileOpen}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Desktop header (hidden on mobile — compact bar above) */}
      <div className="hidden items-center gap-3 border-b border-white/10 px-5 py-4 lg:flex">
        <Link href="/admin" aria-label="Khareedo admin home">
          <Image
            src="/favicon.svg"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9"
          />
        </Link>
        <div>
          <p className="text-sm font-bold leading-tight">Khareedo</p>
          <p className="text-[11px] leading-tight text-white/60">Admin Panel</p>
        </div>
      </div>

      <nav
        aria-label="Admin navigation"
        className={cn(
          "flex-1 space-y-0.5 overflow-y-auto p-3 thin-scrollbar max-lg:py-2",
          mobileOpen ? "block" : "hidden lg:block"
        )}
      >
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-white/15 text-white"
                  : "text-white/70 hover:bg-white/10 hover:text-white"
              )}
              onClick={closeMobile}
              aria-current={active ? "page" : undefined}
            >
              <item.icon className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
              <span className="flex-1">{item.label}</span>
              {item.href === "/admin/orders" && pendingOrders > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold">
                  {pendingOrders}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className={cn("space-y-0.5 border-t border-white/10 p-3", mobileOpen ? "block" : "hidden lg:block")}>
        <Link
          href="/"
          onClick={closeMobile}
          className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Store className="h-4.5 w-4.5" aria-hidden="true" /> View Storefront
        </Link>
        <button
          type="button"
          onClick={async () => {
            await signOut({ redirect: false });
            router.push("/admin/login");
            router.refresh();
          }}
          className="flex w-full items-center gap-3 rounded-lg border border-white/20 px-3 py-2.5 text-sm font-medium text-white/90 transition-colors hover:bg-white/10"
        >
          <LogOut className="h-4.5 w-4.5" aria-hidden="true" /> Logout
        </button>
      </div>
    </aside>
  );
}
