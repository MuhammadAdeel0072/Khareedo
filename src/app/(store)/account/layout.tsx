// Account layout — sidebar navigation for customer account pages (FR-05/06).
import Link from "next/link";
import { redirect } from "next/navigation";
import { Heart, MapPin, Package, User } from "lucide-react";
import { getRequestSession, getSessionUser } from "@/lib/auth-guard";
import { initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/account", label: "Overview", icon: User },
  { href: "/account/orders", label: "My Orders", icon: Package },
  { href: "/account/wishlist", label: "Wishlist", icon: Heart },
  { href: "/account/addresses", label: "Addresses", icon: MapPin },
  { href: "/account/profile", label: "Profile", icon: User },
];

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequestSession();
  if (!session?.user?.id) redirect("/login?callbackUrl=/account");
  const user = await getSessionUser();

  return (
    <div className="container-khd py-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[250px_1fr]">
        <aside className="h-fit rounded-xl border p-4 lg:sticky lg:top-40">
          <div className="flex items-center gap-3 border-b pb-4">
            <Avatar className="h-11 w-11">
              <AvatarFallback className="bg-primary text-sm font-bold text-primary-foreground">
                {initials(user?.name ?? user?.email)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{user?.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
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
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
