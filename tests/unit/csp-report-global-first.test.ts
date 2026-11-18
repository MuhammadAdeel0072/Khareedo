// Regression test: the global rate-limit bucket of POST /api/csp-report
// must be checked BEFORE clientIp() or any per-IP bucket
// (src/app/api/csp-report/route.ts).
//
// After the global cap is reached, a request must be rejected without ever
// calling clientIp() or touching a per-IP bucket — otherwise a flood of
// rotating spoofed IPs would keep creating new per-IP entries in the
// in-memory Map even though every request is rejected.
//
// This test lives in its own file on purpose: it spies on the rate-limit
// module with vi.mock, and a mocked module is shared across every
// vi.resetModules() in the same file, which would break the per-test
// isolation the other csp-report tests rely on.
//
// The spies wrap the REAL implementation (not a stub): the test asserts on
// *which* functions the route calls, so the wrappers record calls while
// delegating to the genuine limiter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CSP_REPORT_GLOBAL_LIMIT } from "@/app/api/csp-report/route";

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    clientIp: vi.fn(actual.clientIp),
    rateLimit: vi.fn(actual.rateLimit),
  };
});

const validReport = JSON.stringify({
  "csp-report": {
    "document-uri": "https://shop.example.com/products/1",
    "violated-directive": "img-src",
    "blocked-uri": "https://evil.example.com/x.png",
  },
});

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

describe("global bucket is checked first", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("requests rejected by the exhausted global bucket never reach the per-IP bucket", async () => {
    vi.resetModules();
    const { POST } = await import("@/app/api/csp-report/route");
    const { clientIp, rateLimit } = await import("@/lib/rate-limit");

    // Exhaust the global bucket with rotating spoofed IPs.
    for (let i = 0; i < CSP_REPORT_GLOBAL_LIMIT; i++) {
      const res = await POST(
        requestFrom(`10.0.${Math.floor(i / 256)}.${i % 256}`),
      );
      expect(res.status).toBe(204);
    }

    // Forget the calls above, then send one more request with a brand-new IP.
    vi.mocked(clientIp).mockClear();
    vi.mocked(rateLimit).mockClear();
    const rejected = await POST(requestFrom("203.0.113.200"));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toMatch(/^\d+$/);

    // The global check ran (and tripped). clientIp() was never called and
    // rateLimit was never called with a per-IP key — so no per-IP bucket
    // was created or checked for the rejected request.
    expect(vi.mocked(clientIp)).not.toHaveBeenCalled();
    expect(vi.mocked(rateLimit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rateLimit)).toHaveBeenCalledWith(
      "csp-report:global",
      CSP_REPORT_GLOBAL_LIMIT,
      60_000,
    );
  });
});
