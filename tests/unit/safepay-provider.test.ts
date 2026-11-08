import { describe, expect, it, vi } from "vitest";
import { loadSafepayConfig } from "@/lib/safepay/config";
import { checkoutRequestSchema, wholePkrToMinor } from "@/lib/safepay/contracts";
import { AuthenticationToken, createSafepayProvider, type HttpTransport } from "@/lib/safepay/provider";
import { prepareHostedRedirect, signReturnState, verifyReturnState } from "@/lib/safepay/redirect";

// The session route imports the application database at module scope; these adapter
// tests never reach persistence, so a stub keeps the suite runnable in fresh clones.
vi.mock("@/lib/db", () => ({ db: { $transaction: vi.fn() } }));
// The activated route authenticates before parsing the body; requests outside the
// Next runtime cannot resolve a session, so the guard is stubbed to "no session".
vi.mock("@/lib/auth-guard", () => ({ getSessionUser: vi.fn(async () => null) }));

import { POST } from "@/app/api/checkout/safepay/session/route";

const env = {
  SAFEPAY_ENVIRONMENT: "sandbox", SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public-key", SAFEPAY_SECRET_KEY: "synthetic-private-key",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-distinct-return-key-32-bytes-long",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-merchant", SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
};
const config = () => loadSafepayConfig(env);
const input = { orderId: "order-1", paymentId: "payment-1", amountMinor: BigInt(100000) };
function tracker(overrides: Record<string, unknown> = {}) {
  return { data: { tracker: {
    token: "synthetic-tracker", environment: "sandbox", state: "TRACKER_STARTED",
    intent: "CYBERSOURCE", mode: "payment", entry_mode: "flex",
    purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } }, ...overrides,
  }, capabilities: { CYBERSOURCE: true } }, status: { errors: [], message: "success" } };
}
const response = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("server-only Safepay configuration", () => {
  it("selects documented API and distinct hosted origins without leaking keys", () => {
    const sandbox = config(), production = loadSafepayConfig({ ...env, SAFEPAY_ENVIRONMENT: "production" });
    expect(sandbox.apiOrigin).toBe("https://sandbox.api.getsafepay.com");
    expect(sandbox.checkoutUrl).toBe("https://sandbox.api.getsafepay.com/embedded/");
    expect(production.apiOrigin).toBe("https://api.getsafepay.com");
    expect(production.checkoutUrl).toBe("https://getsafepay.com/embedded/");
    expect(JSON.stringify(sandbox)).not.toContain(env.SAFEPAY_SECRET_KEY);
    expect(JSON.stringify(sandbox)).not.toContain(env.SAFEPAY_MERCHANT_API_KEY);
    expect(JSON.stringify(sandbox)).not.toContain(env.SAFEPAY_RETURN_STATE_SECRET);
  });
  it.each(Object.keys(env))("rejects missing %s without echoing values", (key) => {
    expect(() => loadSafepayConfig({ ...env, [key]: undefined })).toThrow("configuration is incomplete or invalid");
  });
  it.each([
    { SAFEPAY_ENVIRONMENT: "development" }, { SAFEPAY_ENTRY_MODE: "" },
    { SAFEPAY_SECRET_KEY: "secret\r\nInjected: header" },
    { SAFEPAY_SITE_ORIGIN: "https://user:password@shop.example.invalid" },
    { SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid/path" },
    { SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid/?redirect=evil" },
    { SAFEPAY_SITE_ORIGIN: "http://shop.example.invalid" },
    { SAFEPAY_RETURN_STATE_SECRET: env.SAFEPAY_SECRET_KEY },
    { SAFEPAY_TIMEOUT_MS: "NaN" }, { SAFEPAY_TIMEOUT_MS: "30001" },
  ])("rejects unsafe configuration %#", (change) => expect(() => loadSafepayConfig({ ...env, ...change })).toThrow());
});

describe("verified Safepay POST adapter", () => {
  it("creates a tracker using the merchant secret, explicit mode and PKR paisas", async () => {
    const http = vi.fn<HttpTransport>(async () => response(tracker()));
    const result = await createSafepayProvider(config(), http).createTracker(input);
    expect(result.kind).toBe("created");
    const [url, init] = http.mock.calls[0];
    expect(url.href).toBe("https://sandbox.api.getsafepay.com/order/payments/v3/");
    expect(new Headers(init.headers).get("X-SFPY-MERCHANT-SECRET")).toBe(env.SAFEPAY_SECRET_KEY);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store", credentials: "omit" });
    expect(JSON.parse(init.body as string)).toEqual({
      merchant_api_key: env.SAFEPAY_MERCHANT_API_KEY, intent: "CYBERSOURCE", mode: "payment",
      entry_mode: "flex", currency: "PKR", amount: 100000,
    });
    expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
  });
  it("attaches reconciliation metadata using Safepay's tracker metadata endpoint", async () => {
    const http = vi.fn<HttpTransport>(async () => new Response(null, { status: 204 }));
    const result = await createSafepayProvider(config(), http).attachTrackerMetadata({
      trackerToken: "synthetic-tracker", orderId: input.orderId,
    });
    expect(result).toEqual({ kind: "updated" });
    const [url, init] = http.mock.calls[0];
    expect(url.href).toBe("https://sandbox.api.getsafepay.com/order/payments/v3/synthetic-tracker/metadata");
    expect(JSON.parse(init.body as string)).toEqual({ data: { order_id: "order-1" } });
    expect(new Headers(init.headers).get("X-SFPY-MERCHANT-SECRET")).toBe(env.SAFEPAY_SECRET_KEY);
  });
  it("returns sanitized diagnostics when tracker metadata setup fails", async () => {
    const http = vi.fn<HttpTransport>(async () => response({
      error_code: "INVALID_METADATA", message: `secret=${env.SAFEPAY_SECRET_KEY}`,
    }, 500));
    const result = await createSafepayProvider(config(), http).attachTrackerMetadata({
      trackerToken: "synthetic-tracker", orderId: input.orderId,
    });
    expect(result).toEqual({
      kind: "failed", code: "HTTP_ERROR", httpStatus: 500,
      providerErrorCode: "INVALID_METADATA", providerMessage: "[redacted]",
    });
    expect(JSON.stringify(result)).not.toContain(env.SAFEPAY_SECRET_KEY);
  });
  it("authenticates with a bodyless documented POST and assumes no expiry", async () => {
    const http = vi.fn<HttpTransport>(async () => response({ data: "synthetic-authentication" }, 200));
    const result = await createSafepayProvider(config(), http).authenticate();
    expect(result.kind).toBe("authenticated");
    expect(http.mock.calls[0][0].pathname).toBe("/client/passport/v1/token");
    expect(http.mock.calls[0][1].body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("synthetic-authentication");
    expect(result).not.toHaveProperty("expiresAt");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])("rejects unsupported whole-PKR input %s", (amount) => {
    expect(() => wholePkrToMinor(amount)).toThrow();
  });
  it("converts PKR without changing the original stored unit", () => expect(wholePkrToMinor(1450)).toBe(BigInt(145000)));
  it("rejects unsafe amount and IDs before sending HTTP", async () => {
    const http = vi.fn<HttpTransport>();
    const provider = createSafepayProvider(config(), http);
    expect((await provider.createTracker({ ...input, amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) })).kind).toBe("failed");
    expect((await provider.createTracker({ ...input, orderId: "../wrong" })).kind).toBe("failed");
    expect(http).not.toHaveBeenCalled();
  });
  it.each([400, 401, 409, 429, 500, 503, 302])("classifies tracker HTTP %s as uncertain and never retries", async (status) => {
    const http = vi.fn<HttpTransport>(async () => response({ error: env.SAFEPAY_SECRET_KEY }, status));
    const result = await createSafepayProvider(config(), http).createTracker(input);
    expect(result).toMatchObject({ kind: "uncertain", code: "HTTP_ERROR", httpStatus: status });
    expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(env.SAFEPAY_SECRET_KEY);
  });
  it("extracts bounded provider error diagnostics from non-2xx tracker responses", async () => {
    const body = { error_code: "INVALID_TRACKER_REQUEST", message: "Invalid tracker request" };
    const http = vi.fn<HttpTransport>(async () => response(body, 422));
    const result = await createSafepayProvider(config(), http).createTracker(input);
    expect(result).toEqual({
      kind: "uncertain", code: "HTTP_ERROR", httpStatus: 422,
      providerErrorCode: "INVALID_TRACKER_REQUEST", providerMessage: "Invalid tracker request",
    });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("keeps malformed and oversized non-2xx responses uncertain without retaining their bodies", async () => {
    const malformed = new Response("not-json", { status: 502 });
    const oversized = new Response("x".repeat(1024 * 1024 + 1), { status: 502 });
    for (const body of [malformed, oversized]) {
      expect(await createSafepayProvider(config(), async () => body).createTracker(input))
        .toEqual({ kind: "uncertain", code: "HTTP_ERROR", httpStatus: 502 });
    }
  });
  it("redacts credentials, tokens and customer identifiers from provider messages", async () => {
    const body = {
      error_code: "INVALID_REQUEST",
      message: `Invalid request; secret=${env.SAFEPAY_SECRET_KEY}; token=synthetic-authentication; customer=Jane Doe; email=customer@example.invalid`,
    };
    const result = await createSafepayProvider(config(), async () => response(body, 400)).createTracker(input);
    expect(result.kind).toBe("uncertain");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(env.SAFEPAY_SECRET_KEY);
    expect(serialized).not.toContain(env.SAFEPAY_MERCHANT_API_KEY);
    expect(serialized).not.toContain("synthetic-authentication");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("customer@example.invalid");
    expect(result).toHaveProperty("providerErrorCode", "INVALID_REQUEST");
  });
  it.each([
    { environment: "production" }, { state: "TRACKER_ENDED" }, { intent: "MPGS" },
    { mode: "subscription" }, { entry_mode: "raw" },
    { purchase_totals: { quote_amount: { currency: "USD", amount: 100000 } } },
    { purchase_totals: { quote_amount: { currency: "PKR", amount: 100001 } } },
  ])("quarantines mismatched successful tracker responses %#", async change => {
    const result = await createSafepayProvider(config(), async () => response(tracker(change))).createTracker(input);
    expect(result).toMatchObject({ kind: "uncertain", code: "TRACKER_MISMATCH" });
  });
  it("does not offer a false card capability", async () => {
    const body = tracker(); body.data.capabilities.CYBERSOURCE = false;
    expect(await createSafepayProvider(config(), async () => response(body)).createTracker(input))
      .toMatchObject({ kind: "uncertain", code: "TRACKER_MISMATCH" });
  });
  it.each([
    { environment: "synthetic-provider-diagnostic" },
    { purchase_totals: { quote_amount: { currency: "synthetic-private-diagnostic", amount: 100000 } } },
  ])("does not retain malformed context fields as financial observations %#", async change => {
    const result = await createSafepayProvider(config(), async () => response(tracker(change))).createTracker(input);
    expect(result).toEqual({ kind: "uncertain", code: "INVALID_RESPONSE" });
  });
  it("rejects malformed JSON, missing fields, error envelopes and oversized bodies", async () => {
    for (const body of [new Response("not-json"), response({ data: {} }),
      response({ ...tracker(), status: { errors: ["synthetic provider error"] } }),
      new Response("x".repeat(1024 * 1024 + 1))]) {
      expect((await createSafepayProvider(config(), async () => body).createTracker(input)).kind).toBe("uncertain");
    }
  });
  it("redacts raw network exceptions", async () => {
    const result = await createSafepayProvider(config(), async () => { throw new Error(env.SAFEPAY_SECRET_KEY); }).createTracker(input);
    expect(result).toEqual({ kind: "uncertain", code: "NETWORK_ERROR" });
  });
  it("times out even when an injected transport ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const http = vi.fn<HttpTransport>(() => new Promise(() => {}));
      const pending = createSafepayProvider(loadSafepayConfig({ ...env, SAFEPAY_TIMEOUT_MS: "100" }), http).createTracker(input);
      await vi.advanceTimersByTimeAsync(101);
      expect(await pending).toEqual({ kind: "uncertain", code: "TIMEOUT" });
      expect(http.mock.calls[0][1].signal?.aborted).toBe(true);
      expect(http).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("reports failed authentication without treating the payment as failed", async () => {
    expect(await createSafepayProvider(config(), async () => response({ error: "no" }, 403)).authenticate())
      .toMatchObject({ kind: "failed", code: "HTTP_ERROR", httpStatus: 403 });
  });
});

describe("local return state and hosted redirection", () => {
  const now = 1800000000000;
  const claims = { orderId: "order-1", paymentId: "payment-1", ownerHash: "a".repeat(64), expiresAt: now + 60000 };
  it("uses a random nonce, signed expiry and server-derived owner binding", () => {
    const first = signReturnState(config(), claims, now), second = signReturnState(config(), claims, now);
    expect(first).not.toBe(second);
    expect(verifyReturnState(config(), first, claims, now)).toMatchObject(claims);
    expect(verifyReturnState(config(), first, { ...claims, ownerHash: "b".repeat(64) }, now)).toBeNull();
    expect(verifyReturnState(config(), first, { ...claims, orderId: "order-2" }, now)).toBeNull();
    expect(verifyReturnState(config(), first, claims, claims.expiresAt)).toBeNull();
    expect(verifyReturnState(config(), first + "changed", claims, now)).toBeNull();
    expect(verifyReturnState(config(), "malformed", claims, now)).toBeNull();
  });
  it("rejects unbounded local lifetimes without inventing a provider token lifetime", () => {
    expect(() => signReturnState(config(), { ...claims, expiresAt: now + 16 * 60000 }, now)).toThrow();
  });
  it("encodes query parameters, fixes both callback origins, redacts URL and sends no-store 303", () => {
    const state = signReturnState(config(), claims, now);
    const redirect = prepareHostedRedirect(config(), {
      trackerToken: "track&encoded=value", authentication: new AuthenticationToken("auth+/=synthetic"), state,
    });
    const url = new URL(redirect.location());
    expect(url.pathname).toBe("/embedded/");
    expect(url.searchParams.get("tracker")).toBe("track&encoded=value");
    expect(url.searchParams.get("tbt")).toBe("auth+/=synthetic");
    expect(url.searchParams.get("source")).toBe("hosted");
    expect(new URL(url.searchParams.get("redirect_url")!).origin).toBe(env.SAFEPAY_SITE_ORIGIN);
    expect(new URL(url.searchParams.get("cancel_url")!).origin).toBe(env.SAFEPAY_SITE_ORIGIN);
    expect(JSON.stringify(redirect)).not.toContain("auth+/=synthetic");
    expect(redirect.response().status).toBe(303);
    expect(redirect.response().headers.get("Cache-Control")).toBe("no-store");
  });
  it("rejects client-supplied amounts, owners and redirect URLs", () => {
    const request = { orderId: "order-1", paymentId: "payment-1", requestKey: "request-key-123456" };
    for (const change of [{ amount: 1 }, { redirect_url: "https://evil.invalid" }, { ownerHash: claims.ownerHash }, { card: "synthetic" }]) {
      expect(checkoutRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
    }
  });
  it("rejects an unauthenticated session request before touching config or HTTP", async () => {
    const http = vi.spyOn(globalThis, "fetch");
    const result = await POST(new Request("http://localhost/api/checkout/safepay/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    // The activated route authenticates first: no session means 401 and no provider I/O.
    expect(result.status).toBe(401);
    expect(http).not.toHaveBeenCalled();
  });
});
