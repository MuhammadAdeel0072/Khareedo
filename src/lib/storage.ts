// Supabase Storage helper — server-side only (service-role key never leaves
// the server). Shared by the admin upload route, the banner image-import
// endpoint and banner orphan-cleanup, so bucket naming, object paths and
// public-URL parsing live in exactly one place.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Single media bucket — banner objects live under the BANNER_IMAGE_PREFIX key prefix. */
export const MEDIA_BUCKET = "product-images";
export const BANNER_IMAGE_PREFIX = "banners";

let cachedClient: SupabaseClient | null = null;

export function getStorageConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

export function getStorageClient(): SupabaseClient | null {
  const config = getStorageConfig();
  if (!config) return null;
  if (!cachedClient) {
    cachedClient = createClient(config.url, config.key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
  return cachedClient;
}

/** Collision-resistant object key: [banners/]<uuid>.<ext> */
export function buildObjectKey(extension: string, prefix?: string): string {
  return prefix ? `${prefix}/${crypto.randomUUID()}.${extension}` : `${crypto.randomUUID()}.${extension}`;
}

/**
 * If the URL points at OUR storage public URL AND the object sits under the
 * banner prefix, return the object key ("banners/<uuid>.<ext>"); otherwise
 * null. Anything not recognised is never eligible for deletion — external
 * hotlinks, product images and legacy paths are untouchable by design.
 */
export function parseBannerStorageObjectPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const config = getStorageConfig();
  if (!config) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  let storageHost: string;
  try {
    storageHost = new URL(config.url).host;
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.host !== storageHost) return null;

  const marker = `/storage/v1/object/public/${MEDIA_BUCKET}/`;
  if (!parsed.pathname.startsWith(marker)) return null;

  const key = decodeURIComponent(parsed.pathname.slice(marker.length));
  if (!key.startsWith(`${BANNER_IMAGE_PREFIX}/`)) return null;
  // Path-traversal hardening: the key must stay inside the banner prefix.
  if (key.includes("..") || key.includes("\\")) return null;
  return key;
}
