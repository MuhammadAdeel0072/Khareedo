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
import { assertPublicHttpUrl, SsrfBlockedError } from "@/lib/ssrf-guard";
import { getProductImageExtension, MAX_PRODUCT_IMAGE_SIZE } from "@/lib/product-image-validation";
import { buildObjectKey, getStorageClient, MEDIA_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

const importSchema = z.object({
  url: z.string().trim().min(8).max(2048),
});

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

async function fetchBoundedImage(rawUrl: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string; extension: string }> {
  let currentUrl: string = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicHttpUrl(currentUrl);

    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "KhareedoBannerImport/1.0", accept: "image/*" },
    });

    // Redirects: re-validate each hop against the SSRF guard.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SsrfBlockedError("The image server returned an invalid redirect.");
      if (hop === MAX_REDIRECTS) throw new SsrfBlockedError("Too many redirects while fetching the image.");
      currentUrl = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      throw new SsrfBlockedError(`The image host responded with HTTP ${response.status}.`);
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new SsrfBlockedError("The URL does not point to an image.");
    }

    // Stream with a hard byte cap — never buffer an unbounded body.
    const reader = response.body?.getReader();
    if (!reader) throw new SsrfBlockedError("The image response had no content.");

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PRODUCT_IMAGE_SIZE) {
        await reader.cancel();
        throw new SsrfBlockedError("The remote image is larger than 5 MB.");
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    if (bytes.length === 0) throw new SsrfBlockedError("The remote image is empty.");
    const extension = getProductImageExtension(bytes, contentType);
    if (!extension) {
      throw new SsrfBlockedError("The remote file is not a supported image (JPEG, PNG, WebP or GIF).");
    }

    return { bytes, contentType, extension };
  }

  throw new SsrfBlockedError("Too many redirects while fetching the image.");
}

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
      ({ bytes, contentType, extension } = await fetchBoundedImage(parsed.data.url));
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
