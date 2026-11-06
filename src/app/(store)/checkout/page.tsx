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

  await mergeGuestCart(user.id);
  const [cart, settings] = await Promise.all([getCartDetails(), getSettings()]);
  if (!cart || cart.items.length === 0) {
    redirect("/cart");
  }

  const savedAddresses: CheckoutAddress[] = (await listAddresses(user.id)).map((a) => ({
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

      <CheckoutFlow
        cart={cart}
        user={{ id: user.id, name: user.name, email: user.email }}
        savedAddresses={savedAddresses}
        initialName={user?.name ?? session?.user?.name ?? ""}
        initialEmail={user?.email ?? session?.user?.email ?? ""}
        config={{
          codEnabled: settings.cod_enabled,
          bankTransferEnabled: settings.bank_transfer_enabled,
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
