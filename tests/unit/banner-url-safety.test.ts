// Unit tests — banner URL safety (banner management task).
// javascript:/data:/blob: and protocol-relative destinations must never reach
// the storefront; uploads, storage URLs, root-relative paths and http(s)
// links are the only accepted references.
import { describe, expect, it } from "vitest";
import { isSafeHttpReference, bannerSchema } from "@/lib/validation";

describe("isSafeHttpReference", () => {
  it("accepts root-relative public paths", () => {
    expect(isSafeHttpReference("/images/banners/hero.png")).toBe(true);
    expect(isSafeHttpReference("/products?category=watches")).toBe(true);
  });

  it("accepts absolute http(s) URLs", () => {
    expect(isSafeHttpReference("https://example.com/banner.jpg")).toBe(true);
    expect(isSafeHttpReference("http://example.com/banner.jpg")).toBe(true);
    expect(isSafeHttpReference("https://proj.supabase.co/storage/v1/object/public/product-images/banners/x.png")).toBe(true);
  });

  it("rejects dangerous schemes", () => {
    expect(isSafeHttpReference("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpReference("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeHttpReference("blob:https://example.com/x")).toBe(false);
    expect(isSafeHttpReference("file:///etc/passwd")).toBe(false);
    expect(isSafeHttpReference("vbscript:x")).toBe(false);
  });

  it("rejects protocol-relative URLs (//host)", () => {
    expect(isSafeHttpReference("//evil.example.com/x.png")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isSafeHttpReference("not a url")).toBe(false);
    expect(isSafeHttpReference("")).toBe(false);
  });
});

describe("bannerSchema — imageUrl and linkUrl hardening", () => {
  const base = { title: "Summer Sale", placement: "HERO", isActive: true, sortOrder: 1 };

  it("accepts an uploaded storage URL", () => {
    const parsed = bannerSchema.parse({
      ...base,
      imageUrl: "https://proj.supabase.co/storage/v1/object/public/product-images/banners/abc.png",
    });
    expect(parsed.imageUrl).toContain("/banners/abc.png");
  });

  it("accepts a root-relative image path", () => {
    expect(() => bannerSchema.parse({ ...base, imageUrl: "/images/banners/hero-main.png" })).not.toThrow();
  });

  it("rejects a javascript: image URL", () => {
    const result = bannerSchema.safeParse({ ...base, imageUrl: "javascript:alert(1)" });
    expect(result.success).toBe(false);
  });

  it("rejects a data: image URL", () => {
    const result = bannerSchema.safeParse({ ...base, imageUrl: "data:image/svg+xml,<svg onload=alert(1)>" });
    expect(result.success).toBe(false);
  });

  it("rejects a javascript: destination link", () => {
    const result = bannerSchema.safeParse({ ...base, imageUrl: "/images/x.png", linkUrl: "javascript:alert(1)" });
    expect(result.success).toBe(false);
  });

  it("accepts a safe http(s) destination link", () => {
    expect(() =>
      bannerSchema.parse({ ...base, imageUrl: "/images/x.png", linkUrl: "https://example.com/promo" })
    ).not.toThrow();
  });

  it("rejects oversized image references", () => {
    const result = bannerSchema.safeParse({ ...base, imageUrl: `https://example.com/${"a".repeat(700)}.png` });
    expect(result.success).toBe(false);
  });
});
