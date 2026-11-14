import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteImage } from "@/lib/remote-image-import";
import { MAX_PRODUCT_IMAGE_SIZE } from "@/lib/product-image-validation";
import { SsrfBlockedError } from "@/lib/ssrf-guard";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);

describe("fetchRemoteImage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a direct image only after its content matches the declared type", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JPEG_BYTES, {
        headers: { "content-type": "image/jpeg" },
      })
    );

    await expect(
      fetchRemoteImage("https://8.8.8.8/product.jpg", { requireHttps: true })
    ).resolves.toMatchObject({
      bytes: JPEG_BYTES,
      contentType: "image/jpeg",
      extension: "jpg",
    });
  });

  it("requires HTTPS for product imports", async () => {
    await expect(
      fetchRemoteImage("http://8.8.8.8/product.jpg", { requireHttps: true })
    ).rejects.toThrow("Enter an HTTPS image URL.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-validates redirects and refuses private or non-HTTPS destinations", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      })
    );

    await expect(
      fetchRemoteImage("https://8.8.8.8/redirect", { requireHttps: true })
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not follow a product-image redirect to public HTTP", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://8.8.8.8/product.jpg" },
      })
    );

    await expect(
      fetchRemoteImage("https://8.8.8.8/redirect", { requireHttps: true })
    ).rejects.toThrow("Enter an HTTPS image URL.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-image responses and mismatched image bytes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response("html", { headers: { "content-type": "text/html" } })
      )
      .mockResolvedValueOnce(
        new Response("not a png", { headers: { "content-type": "image/png" } })
      );

    await expect(fetchRemoteImage("https://8.8.8.8/page")).rejects.toThrow(
      "must point directly"
    );
    await expect(fetchRemoteImage("https://8.8.8.8/fake.png")).rejects.toThrow(
      "not a valid"
    );
  });

  it("rejects oversized responses from both headers and streamed bytes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JPEG_BYTES, {
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(MAX_PRODUCT_IMAGE_SIZE + 1),
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              const oversized = new Uint8Array(MAX_PRODUCT_IMAGE_SIZE + 1);
              oversized.set(JPEG_BYTES);
              controller.enqueue(oversized);
              controller.close();
            },
          }),
          { headers: { "content-type": "image/jpeg" } }
        )
      );

    await expect(fetchRemoteImage("https://8.8.8.8/large.jpg")).rejects.toThrow(
      "larger than 5 MB"
    );
    await expect(fetchRemoteImage("https://8.8.8.8/stream.jpg")).rejects.toThrow(
      "larger than 5 MB"
    );
  });
});
