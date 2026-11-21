// Cart page (FR-15/16/17).
import type { Metadata } from "next";
import { CartView, CartSkeleton } from "@/components/cart/cart-view";
import { getCartDetails } from "@/services/cart.service";
import { getSettings } from "@/services/settings.service";
import { getSessionUser } from "@/lib/auth-guard";
import { mergeGuestCartAction } from "@/actions/cart";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Shopping Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const user = await getSessionUser();
  // Phase 3, H-6/D7: landing on the cart page merges any guest cart into
  // the signed-in customer's cart — guest items no longer stay invisible
  // until checkout. The merge is a Server Action (see src/actions/cart.ts)
  // so the guest-cart cookie is actually cleared, not left stale as it was
  // from the checkout-page call site. Cart details are read after the
  // merge, so the rendered cart already includes the merged lines; the
  // summary is shown as a notice by CartView. Anonymous visitors skip the
  // merge entirely — their guest cart is untouched.
  const mergeSummary = user ? await mergeGuestCartAction() : null;
  const [cart, settings] = await Promise.all([getCartDetails(), getSettings()]);

  return (
    <div className="container-khd py-8">
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight sm:text-3xl">Shopping Cart</h1>
      <Suspense fallback={<CartSkeleton />}>
        <CartView
          initialCart={cart}
          mergeSummary={mergeSummary}
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
