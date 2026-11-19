import { z } from "zod";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { handleRoute, jsonError, jsonOk, parseBody } from "@/lib/api";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { fetchRemoteImage } from "@/lib/remote-image-import";
import { SsrfBlockedError } from "@/lib/ssrf-guard";
import { buildObjectKey, getStorageClient, MEDIA_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

const importSchema = z.object({
  url: z.string().trim().min(8).max(2048),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireAdminMfaVerified();

    const limit = rateLimit(`product-image-import:${clientIp(request.headers)}`, 10, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many imports. Please try again in ${limit.retryAfterSec}s.`, 429);
    }

    const parsed = await parseBody(request, importSchema);
    if (parsed.error) return parsed.error;

    let image: Awaited<ReturnType<typeof fetchRemoteImage>>;
    try {
      image = await fetchRemoteImage(parsed.data.url, { requireHttps: true });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return jsonError(error.message, 422, {
          code: "IMPORT_BLOCKED",
          errors: { imageUrl: error.message },
        });
      }
      console.error(
        "[product-image-import] Remote image fetch failed:",
        error instanceof Error ? error.name : "unknown"
      );
      return jsonError("Could not import the image. Check the URL and try again.", 502, {
        code: "IMPORT_FAILED",
      });
    }

    const supabase = getStorageClient();
    if (!supabase) {
      console.error("[product-image-import] Supabase Storage configuration is missing.");
      return jsonError("Image storage is not configured.", 500);
    }

    const objectKey = buildObjectKey(image.extension);
    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(objectKey, new Blob([image.bytes], { type: image.contentType }), {
        contentType: image.contentType,
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      console.error("[product-image-import] Storage upload failed.");
      return jsonError("Image import failed. Please try again.", 500);
    }

    const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(objectKey);
    return jsonOk({ url: data.publicUrl, imported: true });
  });
}
