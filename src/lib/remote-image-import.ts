import "server-only";
import { assertPublicHttpUrl, SsrfBlockedError } from "@/lib/ssrf-guard";
import {
  getProductImageExtension,
  MAX_PRODUCT_IMAGE_SIZE,
} from "@/lib/product-image-validation";

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

export interface ImportedImageBytes {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  extension: string;
}

export async function fetchRemoteImage(
  rawUrl: string,
  options: { requireHttps?: boolean } = {}
): Promise<ImportedImageBytes> {
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicHttpUrl(currentUrl);
    if (options.requireHttps && url.protocol !== "https:") {
      throw new SsrfBlockedError("Enter an HTTPS image URL.");
    }

    const response = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "KhareedoImageImport/1.0",
        accept: "image/*",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new SsrfBlockedError("The image server returned an invalid redirect.");
      }
      if (hop === MAX_REDIRECTS) {
        throw new SsrfBlockedError("Too many redirects while fetching the image.");
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      throw new SsrfBlockedError(`The image host responded with HTTP ${response.status}.`);
    }

    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const supportedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ];
    if (!supportedTypes.includes(contentType)) {
      throw new SsrfBlockedError(
        "The URL must point directly to a JPEG, PNG, WebP or GIF image."
      );
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PRODUCT_IMAGE_SIZE) {
      throw new SsrfBlockedError("The remote image is larger than 5 MB.");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new SsrfBlockedError("The image response had no content.");
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
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
    } finally {
      reader.releaseLock();
    }

    if (total === 0) {
      throw new SsrfBlockedError("The image response was empty.");
    }

    const bytes = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const extension = getProductImageExtension(bytes, contentType);
    if (!extension) {
      throw new SsrfBlockedError(
        "The downloaded file is not a valid JPEG, PNG, WebP or GIF image."
      );
    }

    return { bytes, contentType, extension };
  }

  throw new SsrfBlockedError("Too many redirects while fetching the image.");
}
