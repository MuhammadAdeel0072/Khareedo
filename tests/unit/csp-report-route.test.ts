// Tests for the CSP violation report endpoint
// (src/app/api/csp-report/route.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCspReport, POST } from "@/app/api/csp-report/route";

function postReport(body: string, ip: string) {
  return POST(
    new Request("http://localhost/api/csp-report", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/csp-report" },
      body,
    }),
  );
}

const validReport = JSON.stringify({
  "csp-report": {
    "document-uri": "https://shop.example.com/products/1?ref=home",
    "violated-directive": "img-src",
    "effective-directive": "img-src",
    "blocked-uri": "https://evil.example.com/x.png?token=abc",
  },
});

describe("parseCspReport", () => {
  it("extracts origins only, never full URLs", () => {
    const summary = parseCspReport(JSON.parse(validReport));
    expect(summary).toEqual({
      documentOrigin: "https://shop.example.com",
      violatedDirective: "img-src",
      blockedOrigin: "https://evil.example.com",
    });
  });

  it("preserves inline/eval/data/blob blocked-uri values", () => {
    for (const blocked of ["inline", "eval", "data", "blob"]) {
      const summary = parseCspReport({
        "csp-report": {
          "document-uri": "https://shop.example.com/",
          "violated-directive": "script-src",
          "blocked-uri": blocked,
        },
      });
      expect(summary?.blockedOrigin).toBe(blocked);
    }
  });

  it("rejects non-objects, missing csp-report, and missing/invalid directives", () => {
    expect(parseCspReport(null)).toBeNull();
    expect(parseCspReport("nope")).toBeNull();
    expect(parseCspReport({})).toBeNull();
    expect(parseCspReport({ "csp-report": {} })).toBeNull();
    expect(
      parseCspReport({
        "csp-report": {
          "document-uri": "https://shop.example.com/",
          "violated-directive": "img-src; DROP TABLE",
        },
      }),
    ).toBeNull();
  });

  it("falls back to unknown for unparsable URLs", () => {
    const summary = parseCspReport({
      "csp-report": {
        "document-uri": "not a url",
        "violated-directive": "img-src",
        "blocked-uri": "also not a url",
      },
    });
    expect(summary?.documentOrigin).toBe("unknown");
    expect(summary?.blockedOrigin).toBe("unknown");
  });
});

describe("POST /api/csp-report", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("answers 204 and logs one sanitised line for a valid report", async () => {
    const res = await postReport(validReport, "10.0.0.1");
    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = String(warnSpy.mock.calls[0][0]);
    expect(JSON.parse(logged)).toEqual({
      type: "csp-report",
      documentOrigin: "https://shop.example.com",
      violatedDirective: "img-src",
      blockedOrigin: "https://evil.example.com",
    });
    // Query strings (which can carry order references or tokens) never leak.
    expect(logged).not.toContain("ref=home");
    expect(logged).not.toContain("token=abc");
  });

  it("answers 204 without logging for invalid JSON or a malformed report", async () => {
    const badJson = await postReport("{not json", "10.0.0.2");
    expect(badJson.status).toBe(204);
    const malformed = await postReport(JSON.stringify({ nope: true }), "10.0.0.3");
    expect(malformed.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops oversized bodies silently with a 204", async () => {
    const big = JSON.stringify({
      "csp-report": {
        "document-uri": "https://shop.example.com/",
        "violated-directive": "img-src",
        "blocked-uri": "https://evil.example.com/",
        padding: "x".repeat(16 * 1024),
      },
    });
    const res = await postReport(big, "10.0.0.4");
    expect(res.status).toBe(204);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("rate-limits a single IP after 30 reports per minute", async () => {
    const ip = "10.0.0.5";
    for (let i = 0; i < 30; i++) {
      const res = await postReport(validReport, ip);
      expect(res.status).toBe(204);
    }
    const limited = await postReport(validReport, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
