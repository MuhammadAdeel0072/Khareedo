// Cart page (FR-15/16/17).
import type { Metadata } from "next";
import { CartView, CartSkeleton } from "@/components/cart/cart-view";
import { getCartDetails } from "@/services/cart.service";
import { getSettings } from "@/services/settings.service";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Shopping Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const [cart, settings] = await Promise.all([getCartDetails(), getSettings()]);

  return (
    <div className="container-khd py-8">
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight sm:text-3xl">Shopping Cart</h1>
      <Suspense fallback={<CartSkeleton />}>
        <CartView
          initialCart={cart}
          whatsappNumber={settings.whatsapp_number}
          storeName={settings.store_name}
          freeDeliveryThreshold={settings.free_delivery_threshold}
          giftWrapEnabled={settings.gift_wrap_enabled}
          giftWrapCharge={settings.gift_wrap_charge}
        />
      </Suspense>
    </div>
  );
}
