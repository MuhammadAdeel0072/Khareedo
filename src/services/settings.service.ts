// Typed store settings service — DB-driven configuration (FR-44, FR-51, FR-32).
import { cache } from "react";
import { revalidateTag, unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "../../generated/postgres-client";

export interface StoreSettings {
  store_name: string;
  store_tagline: string;
  store_email: string;
  store_phone: string;
  store_address: string;
  whatsapp_number: string; // digits only, country code first (e.g. 923001234567)
  announcement_text: string;
  cod_enabled: boolean;
  bank_transfer_enabled: boolean;
  online_payment_enabled: boolean;
  delivery_fee_standard: number;
  delivery_fee_express: number;
  free_delivery_threshold: number;
  gift_wrap_enabled: boolean;
  gift_wrap_charge: number;
  gift_wrap_description: string;
  facebook_url: string;
  instagram_url: string;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  store_name: "Khareedo",
  store_tagline: "Everyday essentials. Better choices.",
  store_email: "support@khareedo.pk",
  store_phone: "+92 300 1234567",
  store_address: "Gulberg III, Lahore, Pakistan",
  whatsapp_number: "923001234567",
  announcement_text: "Free Delivery on Orders Above Rs 3,000",
  cod_enabled: true,
  bank_transfer_enabled: false,
  online_payment_enabled: false,
  delivery_fee_standard: 200,
  delivery_fee_express: 400,
  free_delivery_threshold: 3000,
  gift_wrap_enabled: true,
  gift_wrap_charge: 150,
  gift_wrap_description: "Premium gift wrapping with ribbon and a personalized note",
  facebook_url: "https://facebook.com/khareedo",
  instagram_url: "https://instagram.com/khareedo",
};

function parse(raw: Record<string, string>): StoreSettings {
  const bool = (k: keyof StoreSettings, dflt: boolean) =>
    raw[k] === undefined ? dflt : raw[k] === "true";
  const int = (k: keyof StoreSettings, dflt: number) => {
    const v = Number(raw[k]);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : dflt;
  };
  const str = (k: keyof StoreSettings, dflt: string) =>
    raw[k] === undefined ? dflt : String(raw[k]);

  return {
    store_name: str("store_name", DEFAULT_SETTINGS.store_name),
    store_tagline: str("store_tagline", DEFAULT_SETTINGS.store_tagline),
    store_email: str("store_email", DEFAULT_SETTINGS.store_email),
    store_phone: str("store_phone", DEFAULT_SETTINGS.store_phone),
    store_address: str("store_address", DEFAULT_SETTINGS.store_address),
    whatsapp_number: str("whatsapp_number", DEFAULT_SETTINGS.whatsapp_number),
    announcement_text: str("announcement_text", DEFAULT_SETTINGS.announcement_text),
    cod_enabled: bool("cod_enabled", DEFAULT_SETTINGS.cod_enabled),
    bank_transfer_enabled: bool("bank_transfer_enabled", DEFAULT_SETTINGS.bank_transfer_enabled),
    online_payment_enabled: bool("online_payment_enabled", DEFAULT_SETTINGS.online_payment_enabled),
    delivery_fee_standard: int("delivery_fee_standard", DEFAULT_SETTINGS.delivery_fee_standard),
    delivery_fee_express: int("delivery_fee_express", DEFAULT_SETTINGS.delivery_fee_express),
    free_delivery_threshold: int("free_delivery_threshold", DEFAULT_SETTINGS.free_delivery_threshold),
    gift_wrap_enabled: bool("gift_wrap_enabled", DEFAULT_SETTINGS.gift_wrap_enabled),
    gift_wrap_charge: int("gift_wrap_charge", DEFAULT_SETTINGS.gift_wrap_charge),
    gift_wrap_description: str("gift_wrap_description", DEFAULT_SETTINGS.gift_wrap_description),
    facebook_url: str("facebook_url", DEFAULT_SETTINGS.facebook_url),
    instagram_url: str("instagram_url", DEFAULT_SETTINGS.instagram_url),
  };
}

/** Read all settings. Always-fresh variant — REQUIRED for checkout, pricing
 *  and payment paths where a stale fee/flag must never be used (BR-06, BR-10). */
export const getSettings = cache(async (): Promise<StoreSettings> => {
  const rows = await db.storeSetting.findMany();
  const raw: Record<string, string> = {};
  for (const r of rows) raw[r.key] = r.value;
  return parse(raw);
});

const SETTINGS_CACHE_TAG = "store-settings";

// Display-only settings (layout header/footer, contact, PDP WhatsApp link,
// order confirmation). Public, admin-authored content — same trust level as
// banners. Invalidated synchronously by saveSettings; checkout/pricing paths
// intentionally keep the always-fresh getSettings() above.
const readSettingsCached = unstable_cache(
  async (): Promise<StoreSettings> => {
    const rows = await db.storeSetting.findMany();
    const raw: Record<string, string> = {};
    for (const r of rows) raw[r.key] = r.value;
    return parse(raw);
  },
  ["store-settings"],
  { revalidate: 300, tags: [SETTINGS_CACHE_TAG] }
);

/** Cached settings read for display-only storefront paths. */
export async function getCachedSettings(): Promise<StoreSettings> {
  return readSettingsCached();
}

/** Upsert a batch of settings (admin only — guarded at route level, BR-14). */
export async function saveSettings(
  values: Partial<Record<keyof StoreSettings, string | boolean | number>>
) {
  const entries = Object.entries(values);
  if (entries.length === 0) return;

  const rows = entries.map(([key, value]) =>
    Prisma.sql`(${key}, ${String(value)}, CURRENT_TIMESTAMP)`
  );
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "StoreSetting" ("key", "value", "updatedAt")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("key") DO UPDATE
    SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
  `);
  revalidateTag(SETTINGS_CACHE_TAG, { expire: 0 });
}
