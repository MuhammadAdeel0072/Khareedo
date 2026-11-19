// Tests for trusted-proxy client IP handling (Phase 2, area G — H-B).
//
// clientIp() only trusts X-Forwarded-For / X-Real-IP when TRUSTED_PROXY_IPS
// is configured. Without it, forwarded headers are client-controlled and
// the caller is reported as "unknown" — per-IP rate limits then collapse
// into one shared bucket instead of handing an attacker a fresh bucket per
// request.
import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "@/lib/rate-limit";
import { isTrustedProxyConfigured, trustedProxyIps } from "@/lib/trusted-proxy";
import { isHttpsDeployment } from "@/lib/site-url";

describe("trustedProxyIps", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it("is empty (unconfigured) by default", () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(trustedProxyIps()).toEqual([]);
    expect(isTrustedProxyConfigured()).toBe(false);
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    process.env.TRUSTED_PROXY_IPS = " 10.0.0.1 , 10.0.0.2,,";
    expect(trustedProxyIps()).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(isTrustedProxyConfigured()).toBe(true);
  });
});

describe("clientIp", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it("ignores forwarded headers when no trusted proxy is configured", () => {
    delete process.env.TRUSTED_PROXY_IPS;
    const headers = new Headers({ "x-forwarded-for": "203.0.113.10" });
    expect(clientIp(headers)).toBe("unknown");
    expect(clientIp({ "x-forwarded-for": "203.0.113.10" })).toBe("unknown");
    expect(clientIp({ "x-real-ip": "203.0.113.10" })).toBe("unknown");
  });

  it("honours the first forwarded entry when a trusted proxy is configured", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
    const headers = new Headers({ "x-forwarded-for": "203.0.113.10, 10.0.0.1" });
    expect(clientIp(headers)).toBe("203.0.113.10");
    expect(clientIp({ "x-real-ip": "203.0.113.11" })).toBe("203.0.113.11");
  });

  it("returns unknown when no forwarded header is present", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp({})).toBe("unknown");
  });
});

describe("isHttpsDeployment", () => {
  it("is true only for an https NEXTAUTH_URL", () => {
    expect(isHttpsDeployment({ NEXTAUTH_URL: "https://shop.example.pk" })).toBe(true);
    expect(isHttpsDeployment({ NEXTAUTH_URL: "http://localhost:3000" })).toBe(false);
    expect(isHttpsDeployment({})).toBe(false);
    expect(isHttpsDeployment({ NEXTAUTH_URL: "https://shop.example.pk/" })).toBe(true);
  });
});
