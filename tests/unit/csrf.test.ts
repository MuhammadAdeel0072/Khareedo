// Tests for CSRF same-origin validation (Phase 2, area C — H-4-G1).
//
// The check runs in the edge proxy for state-changing API requests:
// an Origin/Referer header that proves another origin -> 403. Requests
// carrying neither header (non-browser clients) are allowed; GETs are
// never checked; the webhook, CSP-report and NextAuth handler paths are
// exempt. The application's own endpoints under /api/auth/*
// (forgot-password, reset-password, resend-verification) are NOT exempt:
// a cross-site POST to any of them must be rejected.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { expectedOrigins, isCsrfExemptPath, isCsrfRejected, isSameOriginRequest } from "@/lib/csrf";

function request(url: string, method: string, headers: Record<string, string> = {}) {
  return new Request(url, { method, headers });
}

describe("isSameOriginRequest", () => {
  it("allows a same-origin POST (Origin matches the app origin)", () => {
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", { origin: "http://localhost:3000" }),
      ),
    ).toBe(true);
  });

  it("allows a same-origin POST via Referer when Origin is absent", () => {
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", {
          referer: "http://localhost:3000/checkout",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a cross-origin POST (the classic CSRF case)", () => {
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", { origin: "https://evil.example.com" }),
      ),
    ).toBe(false);
  });

  it("rejects a cross-origin Referer when Origin is absent", () => {
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", {
          referer: "https://evil.example.com/lure",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a malformed Origin and a malformed Referer", () => {
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", { origin: "not a url" }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", { referer: "not a url" }),
      ),
    ).toBe(false);
  });

  it("allows requests with neither Origin nor Referer (non-browser clients)", () => {
    expect(isSameOriginRequest(request("http://localhost:3000/api/cart", "POST"))).toBe(true);
  });

  it("never checks safe methods", () => {
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "GET", { origin: "https://evil.example.com" }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "GET", { origin: "https://evil.example.com" }),
      ),
    ).toBe(true);
  });

  it("accepts the NEXTAUTH_URL origin as well as the request origin", () => {
    const env = { ...process.env, NEXTAUTH_URL: "https://shop.example.pk" };
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", { origin: "https://shop.example.pk" }),
        env,
      ),
    ).toBe(true);
    // And the request's own origin still works when NEXTAUTH_URL is set.
    expect(
      isSameOriginRequest(
        request("http://localhost:3000/api/cart", "POST", { origin: "http://localhost:3000" }),
        env,
      ),
    ).toBe(true);
    expect(expectedOrigins(request("http://localhost:3000/api/cart", "POST"), env).size).toBe(2);
  });
});

describe("isCsrfExemptPath", () => {
  it("exempts the webhook, the CSP report endpoint, and the NextAuth handler", () => {
    expect(isCsrfExemptPath("/api/webhooks/safepay")).toBe(true);
    expect(isCsrfExemptPath("/api/csp-report")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/session")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/csrf")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/providers")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/error")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/verify-request")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/signin")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/signin/google")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/signout")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/callback/credentials")).toBe(true);
    expect(isCsrfExemptPath("/api/auth/callback/google")).toBe(true);
  });

  it("does NOT exempt the custom authentication endpoints", () => {
    // Application routes, not NextAuth endpoints: a cross-site POST to any
    // of these must go through the same-origin check (see isCsrfRejected).
    expect(isCsrfExemptPath("/api/auth/forgot-password")).toBe(false);
    expect(isCsrfExemptPath("/api/auth/reset-password")).toBe(false);
    expect(isCsrfExemptPath("/api/auth/resend-verification")).toBe(false);
  });

  it("does not exempt lookalike paths under /api/auth", () => {
    expect(isCsrfExemptPath("/api/auth")).toBe(false);
    expect(isCsrfExemptPath("/api/auth/unknown-route")).toBe(false);
    expect(isCsrfExemptPath("/api/authentication/login")).toBe(false);
    expect(isCsrfExemptPath("/api/auth/callback")).toBe(false);
  });

  it("does not exempt ordinary API routes", () => {
    expect(isCsrfExemptPath("/api/cart")).toBe(false);
    expect(isCsrfExemptPath("/api/checkout/place")).toBe(false);
    expect(isCsrfExemptPath("/api/admin/products")).toBe(false);
    expect(isCsrfExemptPath("/api/webhooks/other")).toBe(false);
  });
});

describe("isCsrfRejected (proxy-facing)", () => {
  it("rejects a cross-site POST to an API route", () => {
    const req = new NextRequest("http://localhost:3000/api/cart", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(isCsrfRejected(req)).toBe(true);
  });

  it("allows a same-origin POST to an API route", () => {
    const req = new NextRequest("http://localhost:3000/api/cart", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    });
    expect(isCsrfRejected(req)).toBe(false);
  });

  it("never rejects a GET, even cross-origin (the Safepay return flow)", () => {
    const req = new NextRequest("http://localhost:3000/api/checkout/safepay/return", {
      method: "GET",
      headers: { origin: "https://evil.example.com" },
    });
    expect(isCsrfRejected(req)).toBe(false);
  });

  it("rejects a cross-site POST to each custom authentication endpoint", () => {
    for (const path of [
      "/api/auth/forgot-password",
      "/api/auth/reset-password",
      "/api/auth/resend-verification",
    ]) {
      const req = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
      });
      expect(isCsrfRejected(req)).toBe(true);
    }
  });

  it("allows a same-origin POST to each custom authentication endpoint", () => {
    for (const path of [
      "/api/auth/forgot-password",
      "/api/auth/reset-password",
      "/api/auth/resend-verification",
    ]) {
      const req = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      });
      expect(isCsrfRejected(req)).toBe(false);
    }
  });

  it("never rejects the NextAuth handler, even with a foreign Origin", () => {
    // The credentials sign-in POST and the sign-out POST go through the
    // NextAuth handler, which validates its own CSRF token.
    for (const path of ["/api/auth/callback/credentials", "/api/auth/signout"]) {
      const req = new NextRequest(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
      });
      expect(isCsrfRejected(req)).toBe(false);
    }
  });

  it("never rejects the CSP report endpoint, even with a foreign Origin", () => {
    const req = new NextRequest("http://localhost:3000/api/csp-report", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(isCsrfRejected(req)).toBe(false);
  });

  it("never rejects the Safepay webhook, even with a foreign Origin", () => {
    const req = new NextRequest("http://localhost:3000/api/webhooks/safepay", {
      method: "POST",
      headers: { origin: "https://getsafepay.com" },
    });
    expect(isCsrfRejected(req)).toBe(false);
  });

  it("never rejects non-API paths", () => {
    const req = new NextRequest("http://localhost:3000/checkout", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(isCsrfRejected(req)).toBe(false);
  });
});
