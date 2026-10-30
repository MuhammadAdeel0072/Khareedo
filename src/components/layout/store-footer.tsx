// Store footer — navigation, contact, trust badges (FR-47).
import Link from "next/link";
import { Mail, MapPin, Phone, Truck, ShieldCheck, RotateCcw, Headset, Tag } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { WhatsAppIcon } from "@/components/layout/whatsapp-icon";
import type { StoreSettings } from "@/services/settings.service";

export function StoreFooter({ settings }: { settings: StoreSettings }) {
  return (
    <footer className="mt-auto border-t bg-muted/60">
      {/* Trust strip */}
      <div className="border-b bg-background">
        <div className="container-khd grid grid-cols-2 gap-4 py-6 md:grid-cols-5">
          <TrustBadge icon={<Truck className="h-6 w-6" />} title="Free Delivery" desc={`On orders above ${formatPKR(settings.free_delivery_threshold)}`} />
          <TrustBadge icon={<ShieldCheck className="h-6 w-6" />} title="Secure Payments" desc="Cash on Delivery available" />
          <TrustBadge icon={<RotateCcw className="h-6 w-6" />} title="Easy Returns" desc="Hassle-free within 7 days" />
          <TrustBadge icon={<Headset className="h-6 w-6" />} title="Customer Support" desc="We're here to help" />
          <TrustBadge icon={<Tag className="h-6 w-6" />} title="Best Deals" desc="New offers every week" />
        </div>
      </div>

      <div className="container-khd grid gap-8 py-10 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
            {settings.store_name} — premium products for your everyday life. Original products,
            cash on delivery and easy returns across Pakistan.
          </p>
        </div>

        <nav aria-label="Shop links">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide">Shop</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li><Link href="/products" className="hover:text-primary">All Products</Link></li>
            <li><Link href="/products?category=watches" className="hover:text-primary">Watches</Link></li>
            <li><Link href="/products?category=electronics" className="hover:text-primary">Electronics</Link></li>
            <li><Link href="/products?category=ladies-handbags" className="hover:text-primary">Handbags</Link></li>
            <li><Link href="/products?category=perfumes" className="hover:text-primary">Perfumes</Link></li>
            <li><Link href="/categories" className="hover:text-primary">All Categories</Link></li>
          </ul>
        </nav>

        <nav aria-label="Account links">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide">My Account</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li><Link href="/account" className="hover:text-primary">My Profile</Link></li>
            <li><Link href="/account/orders" className="hover:text-primary">Order History</Link></li>
            <li><Link href="/account/wishlist" className="hover:text-primary">Wishlist</Link></li>
            <li><Link href="/cart" className="hover:text-primary">Shopping Cart</Link></li>
            <li><Link href="/login" className="hover:text-primary">Sign In</Link></li>
            <li><Link href="/register" className="hover:text-primary">Create Account</Link></li>
          </ul>
        </nav>

        <div>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide">Contact Us</h3>
          <ul className="space-y-2.5 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{settings.store_phone}</span>
            </li>
            <li className="flex items-start gap-2">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <a href={`mailto:${settings.store_email}`} className="hover:text-primary">{settings.store_email}</a>
            </li>
            <li className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>{settings.store_address}</span>
            </li>
            <li className="flex items-start gap-2">
              <WhatsAppIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <a
                href={`https://wa.me/${settings.whatsapp_number.replace(/\D/g, "")}?text=${encodeURIComponent(`Hello ${settings.store_name}! I need some assistance with my shopping.`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary"
              >
                WhatsApp Assistance
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t">
        <div className="container-khd flex flex-col items-center justify-between gap-2 py-4 text-xs text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} {settings.store_name}. All rights reserved.</p>
          <p className="flex items-center gap-3">
            <span>Cash on Delivery</span>
            <span aria-hidden="true">·</span>
            <span>7-Day Easy Returns</span>
            <span aria-hidden="true">·</span>
            <span>100% Original Products</span>
          </p>
        </div>
      </div>
    </footer>
  );
}

function TrustBadge({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-50 text-primary" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{desc}</p>
      </div>
    </div>
  );
}

function formatPKR(n: number) {
  return `Rs ${n.toLocaleString("en-PK")}`;
}
