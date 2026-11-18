// Tests for the security-header set and report-only CSP
// (src/lib/security-headers.ts) and its wiring in next.config.ts.
import { describe, expect, it } from "vitest";
import {
  buildReportOnlyCsp,
  buildSecurityHeaders,
  CSP_IMAGE_HOSTS,
  HSTS_HEADER_VALUE,
  REPORT_ONLY_CSP_DIRECTIVES,
} from "@/lib/security-headers";
import nextConfig from "../../next.config";

function headerMap(headers: Array<{ key: string; value: string }>) {
  return new Map(headers.map((h) => [h.key.toLowerCase(), h.value]));
}

function parseCsp(value: string): Map<string, string> {
  return new Map(
    value.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/);
      return [name, rest.join(" ")] as [string, string];
    }),
  );
}

describe("buildSecurityHeaders", () => {
  it("sends the full non-HSTS set in development", () => {
    const headers = headerMap(buildSecurityHeaders({ isProduction: false }));
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("permissions-policy")).toContain("microphone=()");
    expect(headers.get("permissions-policy")).toContain("geolocation=()");
    expect(headers.get("permissions-policy")).toContain("payment=()");
    expect(headers.has("strict-transport-security")).toBe(false);
    expect(headers.has("content-security-policy-report-only")).toBe(true);
  });

  it("adds HSTS only in production, with no preload or includeSubDomains", () => {
    const prod = headerMap(buildSecurityHeaders({ isProduction: true }));
    expect(prod.get("strict-transport-security")).toBe(HSTS_HEADER_VALUE);
    expect(prod.get("strict-transport-security")).toBe("max-age=63072000");
    expect(prod.get("strict-transport-security")).not.toContain("preload");
    expect(prod.get("strict-transport-security")).not.toContain("includeSubDomains");
  });

  it("supports pinning a stricter referrer policy for specific routes", () => {
    const headers = headerMap(
      buildSecurityHeaders({ isProduction: false, referrerPolicy: "no-referrer" }),
    );
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never emits an enforcing Content-Security-Policy header", () => {
    for (const isProduction of [false, true]) {
      const headers = headerMap(buildSecurityHeaders({ isProduction }));
      expect(headers.has("content-security-policy")).toBe(false);
      expect(headers.has("content-security-policy-report-only")).toBe(true);
    }
  });
});

describe("report-only CSP", () => {
  it("is report-only and built from the declared directives", () => {
    const directives = parseCsp(buildReportOnlyCsp());
    expect(directives.get("default-src")).toBe("'self'");
    expect(directives.get("script-src")).toBe("'self' 'unsafe-inline'");
    expect(directives.get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(directives.get("font-src")).toBe("'self'");
    expect(directives.get("connect-src")).toBe("'self'");
    expect(directives.get("frame-src")).toBe("'none'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("form-action")).toBe("'self'");
    expect(directives.get("worker-src")).toBe("'none'");
    expect(directives.get("report-uri")).toBe("/api/csp-report");
  });

  it("allows exactly the remote image hosts from next.config remotePatterns", () => {
    const directives = parseCsp(buildReportOnlyCsp());
    const imgSrc = directives.get("img-src") ?? "";
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain("data:");
    for (const host of CSP_IMAGE_HOSTS) {
      expect(imgSrc).toContain(host);
    }
    expect(imgSrc).not.toContain("*");
  });

  it("never uses unsafe-eval or wildcards anywhere", () => {
    const csp = buildReportOnlyCsp();
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain(" *");
    for (const [, value] of REPORT_ONLY_CSP_DIRECTIVES) {
      expect(value).not.toContain("*");
    }
  });
});

describe("next.config.ts wiring", () => {
  it("applies the security headers to every path", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const routes = await nextConfig.headers!();
    expect(routes).toHaveLength(3);
    expect(routes[0].source).toBe("/:path*");
    const headers = headerMap(routes[0].headers);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.has("content-security-policy-report-only")).toBe(true);
    expect(headers.has("content-security-policy")).toBe(false);
  });

  it("pins no-referrer on the Safepay routes, keeping every other header", async () => {
    const routes = await nextConfig.headers!();
    const base = headerMap(routes[0].headers);
    const safepaySources = routes.slice(1).map((r) => r.source);
    expect(safepaySources).toEqual([
      "/api/checkout/safepay/:path*",
      "/api/webhooks/safepay",
    ]);
    for (const route of routes.slice(1)) {
      const headers = headerMap(route.headers);
      expect(headers.get("referrer-policy")).toBe("no-referrer");
      for (const [key, value] of base) {
        if (key === "referrer-policy") continue;
        expect(headers.get(key)).toBe(value);
      }
      expect(headers.has("content-security-policy")).toBe(false);
    }
  });

  it("does not include HSTS when NODE_ENV is not production", async () => {
    const routes = await nextConfig.headers!();
    const headers = headerMap(routes[0].headers);
    // Vitest runs with NODE_ENV=test; HSTS must only appear in production.
    if (process.env.NODE_ENV !== "production") {
      expect(headers.has("strict-transport-security")).toBe(false);
    }
  });
});
