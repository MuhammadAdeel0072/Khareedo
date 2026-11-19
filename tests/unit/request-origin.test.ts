import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestOrigin } from "@/lib/request-origin";

const headers = (entries: Record<string, string> = {}) => new Headers(entries);

describe("request-origin derivation", () => {
  beforeEach(() => {
    // These tests simulate a deployment behind a trusted proxy, so the
    // forwarded headers are honoured (Phase 2, area G: forwarded headers
    // are only trusted when TRUSTED_PROXY_IPS is configured).
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
  });

  afterEach(() => {
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it("uses the direct host header as plain HTTP when no proxy headers exist", () => {
    expect(requestOrigin(headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });

  it("follows forwarded host and proto behind a preview/proxy gateway", () => {
    expect(requestOrigin(headers({
      host: "internal:3000",
      "x-forwarded-host": "preview-abc.space-z.ai",
      "x-forwarded-proto": "https",
    }))).toBe("https://preview-abc.space-z.ai");
  });

  it("takes the first value of multi-hop forwarded headers", () => {
    expect(requestOrigin(headers({
      "x-forwarded-host": "shop.example.pk, inner.example.pk",
      "x-forwarded-proto": "https,http",
    }))).toBe("https://shop.example.pk");
  });

  it("returns null without a host or with unsafe/unparseable input", () => {
    expect(requestOrigin(headers())).toBeNull();
    expect(requestOrigin(headers({ host: "" }))).toBeNull();
    // The Headers constructor itself rejects CR/LF, so a space exercises the guard.
    expect(requestOrigin(headers({ host: "evil host" }))).toBeNull();
    expect(requestOrigin(headers({ host: "x".repeat(300) }))).toBeNull();
    expect(requestOrigin(headers({ host: "shop.example.pk", "x-forwarded-proto": "ftp" }))).toBeNull();
  });

  it("ignores forwarded headers when no trusted proxy is configured", () => {
    // Fail-safe (Phase 2, area G): without TRUSTED_PROXY_IPS, forwarded
    // headers are client-controlled and must not mint an origin.
    delete process.env.TRUSTED_PROXY_IPS;
    expect(requestOrigin(headers({
      host: "internal:3000",
      "x-forwarded-host": "preview-abc.space-z.ai",
      "x-forwarded-proto": "https",
    }))).toBe("http://internal:3000");
    // Forwarded headers alone, with no host at all, cannot mint an origin.
    expect(requestOrigin(headers({
      "x-forwarded-host": "shop.example.pk",
      "x-forwarded-proto": "https",
    }))).toBeNull();
  });
});
