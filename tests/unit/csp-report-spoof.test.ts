// Tests for spoofed X-Forwarded-For headers against POST /api/csp-report
// (src/app/api/csp-report/route.ts).
//
// The endpoint's per-IP rate limit trusts the first X-Forwarded-For entry,
// which is client-controlled unless a trusted proxy overwrites it (see
// docs/SECURITY-HEADERS.md — the repo's Caddyfile does overwrite it, but
// nothing establishes that this Caddyfile is the production proxy or that
// :3000 is not directly reachable). These tests prove the global cap bounds
// the damage: no spoofed header can push intake past
// CSP_REPORT_GLOBAL_LIMIT per minute, whatever the claimed IP is.
//
// Each test loads a fresh copy of the route module (vi.resetModules +
// dynamic import), because the in-memory rate-limit buckets are module
// state shared by every POST in the file — without a reset, one test's
// requests would consume the next test's global budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CSP_REPORT_GLOBAL_LIMIT,
  CSP_REPORT_PER_IP_LIMIT,
} from "@/app/api/csp-report/route";

const validReport = JSON.stringify({
  "csp-report": {
    "document-uri": "https://shop.example.com/products/1",
    "violated-directive": "img-src",
    "blocked-uri": "https://evil.example.com/x.png",
  },
});

async function freshPost() {
  vi.resetModules();
  const mod = await import("@/app/api/csp-report/route");
  return mod.POST;
}

function requestFrom(ip: string) {
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/csp-report",
    },
    body: validReport,
  });
}

describe("spoofed X-Forwarded-For headers", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // These tests simulate a deployment behind a trusted proxy, so the
    // forwarded headers are honoured as distinct client IPs (Phase 2,
    // area G) and the global cap is the backstop against spoofing.
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.TRUSTED_PROXY_IPS;
  });

  it("a single spoofed IP still hits the per-IP cap", async () => {
    const POST = await freshPost();
    for (let i = 0; i < CSP_REPORT_PER_IP_LIMIT; i++) {
      expect((await POST(requestFrom("203.0.113.99"))).status).toBe(204);
    }
    const limited = await POST(requestFrom("203.0.113.99"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("rotating spoofed IPs cannot bypass the global cap", async () => {
    const POST = await freshPost();
    // A new "client IP" on every request — the spoofed-header flood.
    // Each claimed IP is used once, so the per-IP bucket never trips;
    // only the global bucket can stop the flood.
    const total = CSP_REPORT_GLOBAL_LIMIT + 100;
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < total; i++) {
      const spoofed = `10.0.${Math.floor(i / 256)}.${i % 256}`;
      const res = await POST(requestFrom(spoofed));
      if (res.status === 204) accepted++;
      else if (res.status === 429) limited++;
      else throw new Error(`unexpected status ${res.status}`);
    }
    expect(accepted).toBe(CSP_REPORT_GLOBAL_LIMIT);
    expect(limited).toBe(100);
  });

  it("a multi-value X-Forwarded-For is keyed on its first entry", async () => {
    const POST = await freshPost();
    // 30 requests claiming to be 203.0.113.7 (via 198.51.100.9) hit the
    // per-IP cap on the 31st — the first entry is the bucket key.
    for (let i = 0; i < CSP_REPORT_PER_IP_LIMIT; i++) {
      expect(
        (await POST(requestFrom("203.0.113.7, 198.51.100.9"))).status,
      ).toBe(204);
    }
    expect(
      (await POST(requestFrom("203.0.113.7, 198.51.100.9"))).status,
    ).toBe(429);
    // The same second entry with a different first entry is a new bucket —
    // i.e. the first entry is what an attacker controls.
    expect(
      (await POST(requestFrom("203.0.113.8, 198.51.100.9"))).status,
    ).toBe(204);
  });

  it("without a trusted proxy, rotating spoofed IPs share one bucket", async () => {
    // Fail-safe (Phase 2, area G): with TRUSTED_PROXY_IPS unset, the
    // forwarded header is client-controlled and ignored, so every request
    // lands in the single "unknown" bucket — spoofing cannot even get past
    // the per-IP cap, let alone reach the global one.
    delete process.env.TRUSTED_PROXY_IPS;
    const POST = await freshPost();
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < CSP_REPORT_GLOBAL_LIMIT + 100; i++) {
      const spoofed = `10.0.${Math.floor(i / 256)}.${i % 256}`;
      const res = await POST(requestFrom(spoofed));
      if (res.status === 204) accepted++;
      else if (res.status === 429) limited++;
      else throw new Error(`unexpected status ${res.status}`);
    }
    expect(accepted).toBe(CSP_REPORT_PER_IP_LIMIT);
    expect(limited).toBe(CSP_REPORT_GLOBAL_LIMIT + 100 - CSP_REPORT_PER_IP_LIMIT);
  });
});
