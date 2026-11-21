// Tests for trusted-proxy client IP handling (Phase 2, area G — H-B).
//
// clientIp() only trusts X-Forwarded-For / X-Real-IP when TRUSTED_PROXY_IPS
// is configured. Without it, forwarded headers are client-controlled and
// the caller is reported as "unknown" — per-IP rate limits then collapse
// into one shared bucket instead of handing an attacker a fresh bucket per
// request.
//
// TRUSTED_PROXY_IPS also accepts CIDR ranges, validates every entry, and
// warns loudly (log only, never a throw) about invalid entries and about
// the unset state in production. Invalid entries are ignored — never
// trusted — so a typo can only degrade to the fail-safe posture, never
// to trusting a header from an unlisted source.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/lib/rate-limit";
import {
  isTrustedProxyConfigured,
  isTrustedProxyIp,
  parseTrustedProxyEntries,
  trustedProxyIps,
  warnTrustedProxyStartup,
} from "@/lib/trusted-proxy";
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

  it("accepts a CIDR /24 range and keeps it as a range", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.0/24";
    expect(trustedProxyIps()).toEqual(["10.0.0.0/24"]);
    expect(isTrustedProxyConfigured()).toBe(true);
  });

  it("normalises a CIDR /32 to the bare single IP", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1/32";
    expect(trustedProxyIps()).toEqual(["10.0.0.1"]);
  });

  it("accepts IPv6 single IPs and CIDR ranges", () => {
    process.env.TRUSTED_PROXY_IPS = "::1, 2001:db8::/32";
    expect(trustedProxyIps()).toEqual(["::1", "2001:db8::/32"]);
    expect(isTrustedProxyConfigured()).toBe(true);
  });

  it("deduplicates exact repeats and /32 duplicates of a bare IP", () => {
    process.env.TRUSTED_PROXY_IPS = " 10.0.0.1,10.0.0.1 , 10.0.0.1/32, 10.0.0.0/24,10.0.0.0/24 ";
    expect(trustedProxyIps()).toEqual(["10.0.0.1", "10.0.0.0/24"]);
  });
});

describe("parseTrustedProxyEntries", () => {
  it("keeps valid entries and reports invalid ones separately", () => {
    const parsed = parseTrustedProxyEntries("10.0.0.1, not-an-ip, 10.0.0.0/24");
    expect(parsed.valid).toEqual(["10.0.0.1", "10.0.0.0/24"]);
    expect(parsed.invalid).toEqual(["not-an-ip"]);
  });

  it("rejects hostnames, out-of-range octets and prefixes, and /0 ranges", () => {
    const parsed = parseTrustedProxyEntries(
      "proxy.example.com, localhost, 999.0.0.1, 10.0.0.1/33, 0.0.0.0/0, ::/0, 10.0.0.1/-1"
    );
    expect(parsed.valid).toEqual([]);
    expect(parsed.invalid).toEqual([
      "proxy.example.com",
      "localhost",
      "999.0.0.1",
      "10.0.0.1/33",
      "0.0.0.0/0",
      "::/0",
      "10.0.0.1/-1",
    ]);
  });

  it("rejects malformed IPv6 and leading-zero IPv4 octets", () => {
    const parsed = parseTrustedProxyEntries("1::2::3, 010.0.0.1, fe80::1%eth0, 2001:db8:::1");
    expect(parsed.valid).toEqual([]);
    expect(parsed.invalid).toHaveLength(4);
  });

  it("accepts host-bits-set CIDR and an IPv6 /128 as a single host", () => {
    const parsed = parseTrustedProxyEntries("10.0.0.1/24, 2001:db8::1/128");
    expect(parsed.valid).toEqual(["10.0.0.1/24", "2001:db8::1"]);
    expect(parsed.invalid).toEqual([]);
  });
});

describe("invalid entries fail closed", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_IPS;
    vi.restoreAllMocks();
  });

  it("ignores invalid entries but keeps the valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1, bogus-entry";
    expect(trustedProxyIps()).toEqual(["10.0.0.1"]);
    expect(isTrustedProxyConfigured()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bogus-entry"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("IGNORED"));
  });

  it("warns at most once per distinct invalid value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY_IPS = "also-bogus-entry";
    trustedProxyIps();
    trustedProxyIps();
    isTrustedProxyConfigured();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("all-invalid config is unconfigured: forwarded headers ignored", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY_IPS = "not-an-ip, 999.0.0.1";
    expect(trustedProxyIps()).toEqual([]);
    expect(isTrustedProxyConfigured()).toBe(false);
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.10" }))).toBe("unknown");
  });
});

describe("isTrustedProxyIp", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it("matches a single IP exactly, and nothing else", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
    expect(isTrustedProxyIp("10.0.0.1")).toBe(true);
    expect(isTrustedProxyIp("10.0.0.2")).toBe(false);
    expect(isTrustedProxyIp("10.0.0.1 ")).toBe(true);
  });

  it("matches any address inside a CIDR /24 and rejects outside it", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.0/24";
    expect(isTrustedProxyIp("10.0.0.1")).toBe(true);
    expect(isTrustedProxyIp("10.0.0.254")).toBe(true);
    expect(isTrustedProxyIp("10.0.1.1")).toBe(false);
    expect(isTrustedProxyIp("10.0.0.256")).toBe(false);
  });

  it("matches a CIDR /32 as exactly one host", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1/32";
    expect(isTrustedProxyIp("10.0.0.1")).toBe(true);
    expect(isTrustedProxyIp("10.0.0.2")).toBe(false);
  });

  it("matches IPv6 singles and CIDR ranges", () => {
    process.env.TRUSTED_PROXY_IPS = "::1, 2001:db8::/32";
    expect(isTrustedProxyIp("::1")).toBe(true);
    expect(isTrustedProxyIp("2001:db8::5")).toBe(true);
    expect(isTrustedProxyIp("2001:db9::1")).toBe(false);
    expect(isTrustedProxyIp("::2")).toBe(false);
  });

  it("is false when nothing is configured (fail closed)", () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(isTrustedProxyIp("10.0.0.1")).toBe(false);
    expect(isTrustedProxyIp("not-an-ip")).toBe(false);
  });
});

describe("warnTrustedProxyStartup", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_IPS;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("warns in production when unset, logs only, and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.TRUSTED_PROXY_IPS;
    expect(() => warnTrustedProxyStartup()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TRUSTED_PROXY_IPS"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown"));
  });

  it("does not warn outside production when unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.TRUSTED_PROXY_IPS;
    warnTrustedProxyStartup();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn in production when a trusted proxy is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
    warnTrustedProxyStartup();
    expect(warn).not.toHaveBeenCalled();
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

  it("honours forwarded headers when the proxy is configured by CIDR", () => {
    process.env.TRUSTED_PROXY_IPS = "10.0.0.0/24";
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.10" }))).toBe("203.0.113.10");
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
