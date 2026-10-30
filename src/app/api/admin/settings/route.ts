// Admin: store settings save (FR-44, FR-51, BR-15 — existing orders keep their snapshots).
import { saveSettings } from "@/services/settings.service";
import { settingsSchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";

export async function PUT(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const parsed = await parseBody(request, settingsSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    await saveSettings({
      store_name: d.store_name,
      store_tagline: d.store_tagline || "",
      store_email: d.store_email,
      store_phone: d.store_phone || "",
      store_address: d.store_address || "",
      whatsapp_number: d.whatsapp_number,
      announcement_text: d.announcement_text || "",
      cod_enabled: d.cod_enabled,
      bank_transfer_enabled: d.bank_transfer_enabled,
      online_payment_enabled: d.online_payment_enabled,
      delivery_fee_standard: d.delivery_fee_standard,
      delivery_fee_express: d.delivery_fee_express,
      free_delivery_threshold: d.free_delivery_threshold,
      gift_wrap_enabled: d.gift_wrap_enabled,
      gift_wrap_charge: d.gift_wrap_charge,
      gift_wrap_description: d.gift_wrap_description || "",
      facebook_url: d.facebook_url || "",
      instagram_url: d.instagram_url || "",
    });
    return jsonOk({});
  });
}
