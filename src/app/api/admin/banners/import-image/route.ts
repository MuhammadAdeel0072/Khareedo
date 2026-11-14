// Admin: import a remote image URL into persistent storage (banner workflow).
//
// Administrators paste an external image URL; the server fetches it under
// strict SSRF protections, verifies it really is a JPEG/PNG/WebP/GIF by
// magic bytes, caps the download size while streaming, and stores it in
// Supabase Storage under the "banners/" prefix. The banner then references
// durable storage instead of a fragile, hotlink-blockable external URL.
//
// Security properties:
// - admin-gated + per-IP rate limited
// - https/http only, no credentials in URL, DNS-resolved private-range block
//   (loopback / private / CGNAT / link-local incl. cloud metadata / reserved)
// - every redirect hop re-validated (max 3), size capped mid-stream,
//   10s timeout, content-type AND magic-byte verification, SVG rejected
import { requireAdmin } from "@/lib/auth-guard";
import { handleRoute, jsonError, jsonOk, parseBody } from "@/lib/api";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { z } from "zod";
import { fetchRemoteImage } from "@/lib/remote-image-import";
import { SsrfBlockedError } from "@/lib/ssrf-guard";
import { buildObjectKey, getStorageClient, MEDIA_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

const importSchema = z.object({
  url: z.string().trim().min(8).max(2048),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();

    const ip = clientIp(request.headers);
    const limit = rateLimit(`banner-import:${ip}`, 10, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many imports. Please try again in ${limit.retryAfterSec}s.`, 429);
    }

    const parsed = await parseBody(request, importSchema);
    if (parsed.error) return parsed.error;

    let bytes: Uint8Array<ArrayBuffer>;
    let contentType: string;
    let extension: string;
    try {
      ({ bytes, contentType, extension } = await fetchRemoteImage(parsed.data.url));
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return jsonError(error.message, 422, { code: "IMPORT_BLOCKED" });
      }
      console.error("[banner-import] fetch failed:", error instanceof Error ? error.name : "unknown");
      return jsonError("Could not download the image. Please check the URL and try again.", 502, {
        code: "IMPORT_FAILED",
      });
    }

    const supabase = getStorageClient();
    if (!supabase) {
      console.error("[banner-import] Supabase Storage configuration is missing.");
      return jsonError("Image storage is not configured.", 500);
    }

    const objectKey = buildObjectKey(extension, "banners");

    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(objectKey, new Blob([bytes], { type: contentType }), {
        contentType,
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      console.error("[banner-import] Storage upload failed.");
      return jsonError("Image import failed. Please try again.", 500);
    }

    const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(objectKey);
    return jsonOk({ url: data.publicUrl, imported: true });
  });
}
