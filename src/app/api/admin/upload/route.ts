import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/auth-guard";
import { handleRoute, jsonError, jsonOk } from "@/lib/api";
import {
  getProductImageExtension,
  MAX_PRODUCT_IMAGE_REQUEST_SIZE,
  MAX_PRODUCT_IMAGE_SIZE,
} from "@/lib/product-image-validation";

export const runtime = "nodejs";

const BUCKET_NAME = "product-images";

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
    await requireAdmin();

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

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[upload] Supabase Storage configuration is missing.");
      return jsonError("Image storage is not configured.", 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });

    const filePath = `${crypto.randomUUID()}.${extension}`;

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, new Blob([bytes], { type: file.type }), {
        contentType: file.type,
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      console.error("[upload] Storage upload failed.");
      return jsonError("Image upload failed. Please try again.", 500);
    }

    const { data } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return jsonOk({ url: data.publicUrl });
  });
}