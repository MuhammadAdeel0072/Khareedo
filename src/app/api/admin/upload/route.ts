// Admin image upload — Supabase Storage, server-side service-role client.
// Shared by product images (bucket root) and banner images ("banners/" key
// prefix, selected with target=banner). Admin-gated, request-size bounded,
// magic-byte validated, collision-resistant object names, upsert disabled.
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";
import {
  getProductImageExtension,
  MAX_PRODUCT_IMAGE_REQUEST_SIZE,
  MAX_PRODUCT_IMAGE_SIZE,
} from "@/lib/product-image-validation";
import { buildObjectKey, getStorageClient, MEDIA_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

async function readBoundedBody(request: Request): Promise<ArrayBuffer | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PRODUCT_IMAGE_REQUEST_SIZE) {
    return null;
  }

  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PRODUCT_IMAGE_REQUEST_SIZE) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export async function POST(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();

    // Uploads write to storage and are expensive per request: 10/min per
    // admin (Phase 2, area A). Keyed on the admin id, not the IP — an admin
    // is authenticated and MFA-verified here, so per-account is the right
    // bucket and it cannot be evaded by rotating IPs.
    const limit = rateLimit(`admin-upload:${admin.id}`, 10, 60 * 1000);
    if (!limit.ok) {
      return jsonError(`Too many uploads. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      return jsonError("Please send the image as multipart form data.", 400);
    }

    const body = await readBoundedBody(request);
    if (!body) {
      return jsonError("Image request size must not exceed 5 MB.", 413);
    }

    let formData: FormData;
    try {
      formData = await new Response(body, {
        headers: { "content-type": contentType },
      }).formData();
    } catch {
      return jsonError("The image upload request is malformed.", 400);
    }

    const file = formData.get("file");

    if (!(file instanceof File)) {
      return jsonError("Please select an image to upload.", 400);
    }

    if (file.size === 0) {
      return jsonError("The selected image is empty.", 400);
    }

    if (file.size > MAX_PRODUCT_IMAGE_SIZE) {
      return jsonError("Image size must not exceed 5 MB.", 413);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const extension = getProductImageExtension(bytes, file.type);
    if (!extension) {
      return jsonError(
        "The file must be a valid JPEG, PNG, WebP or GIF image.",
        415
      );
    }

    const supabase = getStorageClient();
    if (!supabase) {
      console.error("[upload] Supabase Storage configuration is missing.");
      return jsonError("Image storage is not configured.", 500);
    }

    // Product uploads keep their legacy bucket-root keys; banner uploads are
    // namespaced so orphan cleanup can safely reason about banner objects.
    const prefix = formData.get("target") === "banner" ? "banners" : undefined;
    const filePath = buildObjectKey(extension, prefix);

    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(filePath, new Blob([bytes], { type: file.type }), {
        contentType: file.type,
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      const errorDetails = typeof error === "object" && error !== null
        ? {
            name: "name" in error && typeof error.name === "string" ? error.name : undefined,
            statusCode: "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined,
            message: "message" in error && typeof error.message === "string" ? error.message : String(error),
          }
        : { message: String(error) };

      console.error("[upload] Storage upload failed.", errorDetails);
      return jsonError("Image upload failed. Please try again.", 500);
    }

    const { data } = supabase.storage
      .from(MEDIA_BUCKET)
      .getPublicUrl(filePath);

    // filePath is the stored object key (collision-resistant, server-generated),
    // never the user-supplied filename or the file contents.
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.UPLOAD_CREATED,
      targetType: "Upload",
      metadata: { fileName: filePath },
    });
    return jsonOk({ url: data.publicUrl });
  });
}