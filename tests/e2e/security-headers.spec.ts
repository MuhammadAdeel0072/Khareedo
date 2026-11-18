// E2E: security response headers and report-only CSP.
//
// Runs against a live app (dev server via playwright.config webServer, or
// E2E_BASE_URL). These tests only assert response headers, so they do not
// need seeded data — /api/health answers even without a database — but they
// do need a running app, so they are NOT run in the sandbox (see
// docs/SECURITY-HEADERS.md).
import { test, expect } from "@playwright/test";

const EXPECTED = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

function expectSecurityHeaders(headers: Record<string, string>) {
  for (const [name, value] of Object.entries(EXPECTED)) {
    expect(headers[name], `header ${name}`).toBe(value);
  }
  expect(headers["permissions-policy"], "header permissions-policy").toContain(
    "camera=()",
  );
  expect(headers["permissions-policy"]).toContain("microphone=()");
  // Report-only CSP: violations are reported, never enforced.
  expect(
    headers["content-security-policy-report-only"],
    "header content-security-policy-report-only",
  ).toContain("default-src 'self'");
  expect(headers["content-security-policy-report-only"]).toContain(
    "report-uri /api/csp-report",
  );
  expect(headers["content-security-policy-report-only"]).not.toContain("unsafe-eval");
  // There must never be an enforcing CSP header.
  expect(
    headers["content-security-policy"],
    "no enforcing content-security-policy header",
  ).toBeUndefined();
}

test.describe("security headers", () => {
  test("storefront, health endpoint and static assets carry the headers", async ({
    request,
  }) => {
    for (const path of ["/", "/api/health", "/site.webmanifest"]) {
      const res = await request.get(path);
      // The storefront may 500 without a database; headers are applied by
      // the server regardless of the page status.
      expectSecurityHeaders(res.headers());
    }
  });

  test("HSTS is either absent (dev over HTTP) or exactly max-age=63072000", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    const hsts = res.headers()["strict-transport-security"];
    if (hsts !== undefined) {
      expect(hsts).toBe("max-age=63072000");
      expect(hsts).not.toContain("preload");
      expect(hsts).not.toContain("includeSubDomains");
    }
  });

  test("Safepay routes keep their stricter no-referrer policy", async ({
    request,
  }) => {
    // Unauthenticated session creation answers 401 with its own
    // Referrer-Policy: no-referrer; the global header must not override it.
    const res = await request.post("/api/checkout/safepay/session", { data: {} });
    expect(res.status()).toBe(401);
    const headers = res.headers();
    expect(headers["referrer-policy"]).toBe("no-referrer");
    // The global headers still apply to this response alongside the
    // route-level override.
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy-report-only"]).toContain(
      "default-src 'self'",
    );
    expect(headers["content-security-policy"]).toBeUndefined();
  });

  test("CSP report endpoint accepts a report with 204", async ({ request }) => {
    const res = await request.post("/api/csp-report", {
      headers: { "content-type": "application/csp-report" },
      data: {
        "csp-report": {
          "document-uri": "http://localhost:3000/",
          "violated-directive": "img-src",
          "blocked-uri": "https://example.com/x.png",
        },
      },
    });
    expect(res.status()).toBe(204);
  });
});
