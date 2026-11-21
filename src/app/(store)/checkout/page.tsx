// Checkout page (FR-19..22, FR-28/29).
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CheckoutFlow, type CheckoutAddress } from "@/components/checkout/checkout-flow";
import { getCartDetails } from "@/services/cart.service";
import { getSettings } from "@/services/settings.service";
import { listAddresses } from "@/services/users.service";
import { getSessionUser } from "@/lib/auth-guard";
import { mergeGuestCart } from "@/services/cart.service";
import { withPerformanceTiming } from "@/lib/performance-timing";
import { isSafepaySandboxSessionConfigured } from "@/lib/safepay/config";

export const metadata: Metadata = { title: "Checkout" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  return withPerformanceTiming("page.checkout", async () => {
  const user = await getSessionUser();
  if (!user) redirect("/login?callbackUrl=%2Fcheckout&reason=checkout");

  // Phase 3, H-7: the merge now reports what was merged and what was
  // skipped (and why) so the flow can tell the customer; the mock in
  // checkout-auth-page.test.ts resolves undefined, so fall back to empty.
  const mergeSummary = (await mergeGuestCart(user.id)) ?? {
    merged: [],
    skipped: [],
    cookieCleared: false,
  };
  // Cart details depend on the merge above; settings and addresses do not —
  // fetch all three in one batch instead of two sequential stages.
  const [cart, settings, savedAddressRows] = await Promise.all([
    getCartDetails(),
    getSettings(),
    listAddresses(user.id),
  ]);
  if (!cart || cart.items.length === 0) {
    redirect("/cart");
  }

  const savedAddresses: CheckoutAddress[] = savedAddressRows.map((a) => ({
        id: a.id,
        label: a.label,
        fullName: a.fullName,
        phone: a.phone,
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        province: a.province,
        postalCode: a.postalCode,
        isDefault: a.isDefault,
      }));

  return (
    <div className="container-khd py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Checkout</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Complete your order in a few simple steps
        </p>
      </div>

      {/* Phase 3, M-13: lines dropped on this load are named, not silently lost. */}
      {(cart.removed ?? []).length > 0 && (
        <div className="mb-4 rounded-xl border border-warning/40 bg-warning/5 p-4" role="status">
          <p className="text-sm font-semibold">
            {(cart.removed ?? []).length} item{(cart.removed ?? []).length === 1 ? "" : "s"} removed from your cart
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {(cart.removed ?? []).map((line) => line.name).join(", ")} {(cart.removed ?? []).length === 1 ? "is" : "are"} no
            longer available.
          </p>
        </div>
      )}

      <CheckoutFlow
        cart={cart}
        mergeSummary={mergeSummary}
        user={{ id: user.id, name: user.name, email: user.email }}
        savedAddresses={savedAddresses}
        initialName={user.name ?? ""}
        initialEmail={user.email}
        config={{
          codEnabled: settings.cod_enabled,
          sandboxPaymentEnabled: isSafepaySandboxSessionConfigured(),
          giftWrapEnabled: settings.gift_wrap_enabled,
          giftWrapCharge: settings.gift_wrap_charge,
          giftWrapDescription: settings.gift_wrap_description,
          freeDeliveryThreshold: settings.free_delivery_threshold,
          deliveryFeeStandard: settings.delivery_fee_standard,
          deliveryFeeExpress: settings.delivery_fee_express,
          whatsappNumber: settings.whatsapp_number,
          storeName: settings.store_name,
        }}
      />
    </div>
    );
  });
}
