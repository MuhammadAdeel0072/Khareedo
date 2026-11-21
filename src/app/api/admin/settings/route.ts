// Admin: store settings save (FR-44, FR-51, BR-15 — existing orders keep their snapshots).
import { saveSettings } from "@/services/settings.service";
import { settingsSchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export async function PUT(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-settings-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
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
    // Keys only, never values: setting values may be sensitive (contact
    // details, payment toggles). The key list shows what changed.
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED,
      targetType: "StoreSetting",
      metadata: {
        keys: [
          "store_name",
          "store_tagline",
          "store_email",
          "store_phone",
          "store_address",
          "whatsapp_number",
          "announcement_text",
          "cod_enabled",
          "online_payment_enabled",
          "delivery_fee_standard",
          "delivery_fee_express",
          "free_delivery_threshold",
          "gift_wrap_enabled",
          "gift_wrap_charge",
          "gift_wrap_description",
          "facebook_url",
          "instagram_url",
        ],
      },
    });
    return jsonOk({});
  });
}
