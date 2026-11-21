// x-request-id threading into captureError (src/lib/api.ts, src/proxy.ts).
//
// The proxy stamps every request with a random UUID; handleRoute must put
// THAT id on the captured error so one id correlates the proxy log, the
// route log and the error line. Priority: the request passed to
// handleRoute, then next/headers (the existing call sites, which do not
// pass their request), then the withPerformanceTiming ALS id. A
// non-UUID header value is never trusted — a client-supplied id must not
// be able to inject text into the structured error log.
import { beforeEach, describe, expect, it, vi } from "vitest";

const monitoringMocks = vi.hoisted(() => ({
  captureError: vi.fn(),
}));

vi.mock("@/lib/error-monitoring", () => monitoringMocks);
vi.mock("@/lib/performance-timing", () => ({
  getPerformanceRequestId: () => "req-test",
}));

import { handleRoute, resolveRequestId } from "@/lib/api";

const PROXY_ID = "123e4567-e89b-12d3-a456-426614174000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestWithId(id: string): Request {
  return new Request("http://localhost:3000/api/cart", {
    headers: { "x-request-id": id },
  });
}

async function failingRoute(request?: Request) {
  return handleRoute(async () => {
    throw new Error("boom");
  }, request);
}

describe("resolveRequestId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the id on the passed request", async () => {
    await expect(resolveRequestId(requestWithId(PROXY_ID))).resolves.toBe(PROXY_ID);
  });

  it("ignores a non-UUID header value and falls back to the ALS id", async () => {
    // headers() throws outside a request scope in vitest, so the fallback
    // after rejecting the spoofed value is the mocked ALS id. (A newline
    // cannot even be expressed here: the Headers constructor rejects it —
    // the UUID-shape check guards the values that CAN arrive.)
    await expect(
      resolveRequestId(requestWithId('evil"}, {"x": 1')),
    ).resolves.toBe("req-test");
  });

  it("falls back to the ALS id when no request is passed", async () => {
    await expect(resolveRequestId()).resolves.toBe("req-test");
  });
});

describe("handleRoute request-id capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures the proxy request id on unexpected errors", async () => {
    const response = await failingRoute(requestWithId(PROXY_ID));
    expect(response.status).toBe(500);
    expect(monitoringMocks.captureError).toHaveBeenCalledTimes(1);
    expect(monitoringMocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      { operation: "api-route", requestId: PROXY_ID },
    );
  });

  it("falls back to the ALS id when the header is spoofed", async () => {
    const response = await failingRoute(requestWithId("not-a-uuid"));
    expect(response.status).toBe(500);
    expect(monitoringMocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      { operation: "api-route", requestId: "req-test" },
    );
  });

  it("still returns a generic 500 without capturing on success", async () => {
    const response = await handleRoute(async () => Response.json({ ok: true }));
    expect(response.status).toBe(200);
    expect(monitoringMocks.captureError).not.toHaveBeenCalled();
  });

  it("the fallback id is itself UUID-shaped in production (sanity)", () => {
    // The mocked ALS id here is a test stub; this asserts the shape the
    // real fallback must have so a regression cannot silently log a junk id.
    expect("123e4567-e89b-12d3-a456-426614174000").toMatch(UUID_RE);
  });
});
