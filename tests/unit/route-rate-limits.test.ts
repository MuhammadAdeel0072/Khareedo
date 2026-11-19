// Tests for the API rate limits added in Phase 2, area A.
//
// Each route returns 429 with a Retry-After header once its budget is
// exhausted. The budgets are per client IP (quote/cart/wishlist/webhook),
// per admin id (upload/import/export), or global-only (health). The
// in-memory limiter is module state, so each test uses a distinct IP or
// admin id and the tests run in one file, in order.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetSessionUser, mockQuoteOrder } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
  mockQuoteOrder: vi.fn(),
}));

vi.mock("@/lib/auth-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-guard")>();
  return { ...actual, getSessionUser: mockGetSessionUser, requireUser: mockGetSessionUser };
});

vi.mock("@/services/checkout.service", () => ({
  quoteOrder: mockQuoteOrder,
}));

const { mockGetCartDetails, mockAddToCart } = vi.hoisted(() => ({
  mockGetCartDetails: vi.fn(),
  mockAddToCart: vi.fn(),
}));

vi.mock("@/services/cart.service", () => ({
  getCartDetails: mockGetCartDetails,
  addToCart: mockAddToCart,
  removeCartItem: vi.fn(),
  applyCartItemUpdate: vi.fn(),
}));

const { mockQueryRaw } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $queryRaw: mockQueryRaw } }));

import { POST as quotePOST } from "@/app/api/checkout/quote/route";
import { GET as cartGET, POST as cartPOST } from "@/app/api/cart/route";
import { GET as healthGET } from "@/app/api/health/route";
import { POST as webhookPOST } from "@/app/api/webhooks/safepay/route";

function postJson(path: string, ip: string, body: unknown = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("route rate limits (Phase 2, area A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The tests simulate a deployment behind a trusted proxy, so each
    // test's distinct forwarded IP gets its own bucket.
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
    mockGetSessionUser.mockResolvedValue({ id: "user-1", role: "CUSTOMER" });
    mockQuoteOrder.mockResolvedValue({ total: 1000 });
    mockGetCartDetails.mockResolvedValue({ items: [], itemCount: 0, subtotal: 0, wrappedUnits: 0, id: null });
    mockAddToCart.mockResolvedValue({ items: [], itemCount: 1, subtotal: 999, wrappedUnits: 0, id: "cart-1" });
  });

  it("limits checkout quotes to 60/min per IP with a 429 + Retry-After", async () => {
    const ip = "203.0.113.101";
    for (let i = 0; i < 60; i++) {
      const res = await quotePOST(postJson("/api/checkout/quote", ip, { deliveryMethod: "STANDARD" }));
      expect(res.status).toBe(200);
    }
    const limited = await quotePOST(postJson("/api/checkout/quote", ip, { deliveryMethod: "STANDARD" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    const body = (await limited.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/try again in \d+s/);
    // A different IP still has its own budget.
    const other = await quotePOST(postJson("/api/checkout/quote", "203.0.113.102", { deliveryMethod: "STANDARD" }));
    expect(other.status).toBe(200);
  });

  it("limits cart reads and writes to a shared 60/min per-IP budget", async () => {
    const ip = "203.0.113.103";
    for (let i = 0; i < 30; i++) {
      expect((await cartGET(new Request("http://localhost/api/cart", { headers: { "x-forwarded-for": ip } }))).status).toBe(200);
    }
    for (let i = 0; i < 30; i++) {
      expect((await cartPOST(postJson("/api/cart", ip, { productId: "p1", quantity: 1 }))).status).toBe(200);
    }
    // The 61st cart request — a GET this time — is limited: reads and
    // writes share one bucket.
    const limited = await cartGET(new Request("http://localhost/api/cart", { headers: { "x-forwarded-for": ip } }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("limits health checks to a global 300/min (no per-IP bucket)", async () => {
    // The health endpoint is unauthenticated, so there is no per-client
    // identity to key on. 300 probes is far above any legitimate monitor.
    mockQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    for (let i = 0; i < 300; i++) {
      const res = await healthGET();
      expect(res.status).toBe(200);
    }
    const limited = await healthGET();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("limits Safepay webhook deliveries globally first, then per IP", async () => {
    // No Safepay env is configured in this test, so the first 60 requests
    // reach config loading and answer 503 (not configured) — the limit is
    // checked BEFORE config loading, so the 61st is a 429 instead.
    const ip = "203.0.113.104";
    for (let i = 0; i < 60; i++) {
      const res = await webhookPOST(
        new Request("http://localhost/api/webhooks/safepay", {
          method: "POST",
          headers: { "x-forwarded-for": ip, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(503);
    }
    const limited = await webhookPOST(
      new Request("http://localhost/api/webhooks/safepay", {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
