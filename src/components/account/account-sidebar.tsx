"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Heart, MapPin, Package, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";

const NAV = [
  { href: "/account", label: "Overview", icon: User },
  { href: "/account/orders", label: "My Orders", icon: Package },
  { href: "/account/wishlist", label: "Wishlist", icon: Heart },
  { href: "/account/addresses", label: "Addresses", icon: MapPin },
  { href: "/account/profile", label: "Profile", icon: User },
];

export function AccountSidebar({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
}) {
  const pathname = usePathname();

  return (
    <aside className={`h-fit rounded-xl border p-4 lg:sticky lg:top-40 ${pathname === "/account/wishlist" ? "hidden lg:block" : ""}`}>
      <div className="flex items-center gap-3 border-b pb-4">
        <Avatar className="h-11 w-11">
          <AvatarFallback className="bg-primary text-sm font-bold text-primary-foreground">
            {initials(name ?? email)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
      </div>
      <nav aria-label="Account navigation" className="mt-3 space-y-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <item.icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
