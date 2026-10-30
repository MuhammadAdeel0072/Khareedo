// Admin settings page (FR-44, FR-51).
import { getSettings } from "@/services/settings.service";
import { SettingsForm } from "@/components/admin/settings-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Admin" };

export default async function AdminSettingsPage() {
  const s = await getSettings();

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Store Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Routine configuration — changes apply to the storefront without code deployments
        </p>
      </div>
      <SettingsForm
        initial={{
          store_name: s.store_name,
          store_tagline: s.store_tagline,
          store_email: s.store_email,
          store_phone: s.store_phone,
          store_address: s.store_address,
          whatsapp_number: s.whatsapp_number,
          announcement_text: s.announcement_text,
          cod_enabled: s.cod_enabled,
          bank_transfer_enabled: s.bank_transfer_enabled,
          online_payment_enabled: s.online_payment_enabled,
          delivery_fee_standard: s.delivery_fee_standard,
          delivery_fee_express: s.delivery_fee_express,
          free_delivery_threshold: s.free_delivery_threshold,
          gift_wrap_enabled: s.gift_wrap_enabled,
          gift_wrap_charge: s.gift_wrap_charge,
          gift_wrap_description: s.gift_wrap_description,
          facebook_url: s.facebook_url,
          instagram_url: s.instagram_url,
        }}
      />
    </div>
  );
}
