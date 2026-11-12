import { describe, expect, it } from "vitest";
import { loadSafepayConfig } from "@/lib/safepay/config";
import { createSafepayProvider, type HttpTransport } from "@/lib/safepay/provider";

// Provider-level tests for the documented Classic Express Checkout refund endpoint
// (POST /order/payments/v3/{tracker}/refund). These tests verify request construction,
// authentication headers, integer minor-unit amounts, and the definitive-vs-uncertain
// failure classification. They are transport-mocked and prove nothing about the real
// sandbox provider (see the sandbox verification procedure for that).
const env = {
  SAFEPAY_ENVIRONMENT: "sandbox", SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public-key", SAFEPAY_SECRET_KEY: "synthetic-private-key",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-distinct-return-key-32-bytes-long",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-merchant", SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
};

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function refundTrackerResponse(state: string, amount: number) {
  return ok({ data: { tracker: {
    token: "synthetic-tracker", environment: "sandbox", state,
    purchase_totals: { quote_amount: { currency: "PKR", amount } },
  } }, status: { errors: [], message: "success" } });
}

const request = (status: number) => new Response(JSON.stringify({ message: "refused" }), { status });

describe("Safepay provider submitRefund", () => {
  it("sends the documented endpoint, merchant-secret header and integer minor-unit body for a full refund", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport: HttpTransport = async (url, init) => {
      calls.push({ url: url.toString(), init });
      return refundTrackerResponse("TRACKER_REFUNDED", 100000);
    };
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(100000) });
    expect(result).toEqual({ kind: "submitted", providerState: "TRACKER_REFUNDED" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sandbox.api.getsafepay.com/order/payments/v3/synthetic-tracker/refund");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Headers;
    expect(headers.get("X-SFPY-MERCHANT-SECRET")).toBe("synthetic-private-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ currency: "PKR", amount: 100000 });
  });

  it("sends a partial refund amount without inventing idempotency keys", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport: HttpTransport = async (url, init) => {
      calls.push({ url: url.toString(), init });
      return refundTrackerResponse("TRACKER_PARTIAL_REFUND", 25000);
    };
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(25000) });
    expect(result).toEqual({ kind: "submitted", providerState: "TRACKER_PARTIAL_REFUND" });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ currency: "PKR", amount: 25000 });
    expect(Object.keys(body).sort()).toEqual(["amount", "currency"]);
  });

  it.each([
    { status: 400 }, { status: 401 }, { status: 403 }, { status: 404 }, { status: 422 }, { status: 429 },
  ])("classifies HTTP $status as a definitive failure (provider refused before processing)", async ({ status }) => {
    const transport: HttpTransport = async () => request(status);
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(100000) });
    expect(result).toMatchObject({ kind: "failed", code: "HTTP_ERROR", httpStatus: status });
  });

  it.each([
    { status: 408 }, { status: 500 }, { status: 502 }, { status: 503 },
  ])("classifies HTTP $status as an uncertain outcome (the provider may still have processed it)", async ({ status }) => {
    const transport: HttpTransport = async () => request(status);
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(100000) });
    expect(result).toMatchObject({ kind: "uncertain", code: "HTTP_ERROR", httpStatus: status });
  });

  it("treats a network failure as uncertain and never retries", async () => {
    let calls = 0;
    const transport: HttpTransport = async () => { calls += 1; throw new Error("ECONNRESET"); };
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(100000) });
    expect(result).toMatchObject({ kind: "uncertain", code: "NETWORK_ERROR" });
    expect(calls).toBe(1);
  });

  it("treats a provider timeout as uncertain (the request may have landed)", async () => {
    const transport: HttpTransport = () => new Promise<Response>(() => undefined); // never resolves
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(100000) });
    expect(result).toMatchObject({ kind: "uncertain", code: "TIMEOUT" });
  });

  it("accepts an unparsable 2xx body as submitted without an advisory state", async () => {
    const transport: HttpTransport = async () => ok({ unexpected: "shape" });
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(100000) });
    expect(result).toEqual({ kind: "submitted" });
  });

  it("rejects invalid tracker tokens and non-positive amounts before any network call", async () => {
    const calls: unknown[] = [];
    const transport: HttpTransport = async (url, init) => { calls.push([url, init]); return ok({}); };
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    expect((await provider.submitRefund({ trackerToken: "", amountMinor: BigInt(1) })).kind).toBe("failed");
    expect((await provider.submitRefund({ trackerToken: "bad token\n", amountMinor: BigInt(1) })).kind).toBe("failed");
    expect((await provider.submitRefund({ trackerToken: "ok", amountMinor: BigInt(0) })).kind).toBe("failed");
    expect((await provider.submitRefund({ trackerToken: "ok", amountMinor: BigInt(-5) })).kind).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("redacts provider error messages that echo credentials", async () => {
    const transport: HttpTransport = async () => new Response(
      JSON.stringify({ message: "invalid secret synthetic-private-key for merchant" }), { status: 402 });
    const provider = createSafepayProvider(loadSafepayConfig(env), transport);
    const result = await provider.submitRefund({ trackerToken: "synthetic-tracker", amountMinor: BigInt(100000) });
    expect(result).toMatchObject({ kind: "failed" });
    if (result.kind !== "failed") return;
    expect(result.providerMessage ?? "").not.toContain("synthetic-private-key");
  });
});
