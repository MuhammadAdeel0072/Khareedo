// Account overview — profile summary, recent orders, wishlist count (FR-26).
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Heart, MapPin, Package } from "lucide-react";
import { getUserProfile, listAddresses } from "@/services/users.service";
import { getUserOrders } from "@/services/orders.service";
import { getWishlist } from "@/services/wishlist.service";
import { getSessionUser } from "@/lib/auth-guard";
import { formatPKR, formatDate } from "@/lib/utils";
import { STATUS_BADGE_CLASSES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata = { title: "My Account" };

export default async function AccountPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?callbackUrl=/account");

  const [profile, orders, wishlist, addresses] = await Promise.all([
    getUserProfile(user.id),
    getUserOrders(user.id, 1, 4),
    getWishlist(user.id),
    listAddresses(user.id),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">My Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Member since {formatDate(profile?.createdAt)}
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          icon={<Package className="h-5 w-5" />}
          label="Total Orders"
          value={String(orders.total)}
          href="/account/orders"
        />
        <SummaryCard
          icon={<Heart className="h-5 w-5" />}
          label="Wishlist Items"
          value={String(wishlist.length)}
          href="/account/wishlist"
        />
        <SummaryCard
          icon={<MapPin className="h-5 w-5" />}
          label="Saved Addresses"
          value={String(addresses.length)}
          href="/account/addresses"
        />
      </div>

      {/* Recent orders */}
      <section className="rounded-xl border p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold">Recent Orders</h2>
          <Button asChild variant="ghost" size="sm" className="gap-1 text-primary">
            <Link href="/account/orders">
              View All <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        {orders.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            You haven&apos;t placed any orders yet.{" "}
            <Link href="/products" className="font-medium text-primary hover:underline">
              Start shopping →
            </Link>
          </p>
        ) : (
          <ul className="divide-y">
            {orders.items.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/account/orders/${o.id}`} className="font-mono text-sm font-bold hover:text-primary">
                    {o.reference}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(o.createdAt)} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"}
                  </p>
                </div>
                <Badge variant="outline" className={STATUS_BADGE_CLASSES[o.status] ?? ""}>
                  {o.status}
                </Badge>
                <span className="text-sm font-bold">{formatPKR(o.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Default address */}
      {addresses.length > 0 && (
        <section className="rounded-xl border p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-bold">Default Address</h2>
            <Button asChild variant="ghost" size="sm" className="text-primary">
              <Link href="/account/addresses">Manage</Link>
            </Button>
          </div>
          {addresses
            .filter((a) => a.isDefault)
            .slice(0, 1)
            .map((a) => (
              <p key={a.id} className="text-sm leading-6 text-muted-foreground">
                <span className="font-medium text-foreground">{a.fullName}</span> · {a.phone}
                <br />
                {a.line1}
                {a.line2 ? `, ${a.line2}` : ""}, {a.city}, {a.province} {a.postalCode ?? ""}
              </p>
            ))}
        </section>
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-xl border p-4 transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-primary" aria-hidden="true">
        {icon}
      </span>
      <div>
        <p className="text-xl font-extrabold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
      <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1" aria-hidden="true" />
    </Link>
  );
}
