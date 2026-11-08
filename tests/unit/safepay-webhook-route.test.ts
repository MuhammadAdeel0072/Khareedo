import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TestSafepayConfigurationError extends Error {}
  return {
    TestSafepayConfigurationError,
    config: { environment: "sandbox", merchantAccountRef: "synthetic-account" },
    loadSafepayConfig: vi.fn(),
    loadSafepayWebhookSecret: vi.fn(),
    loadPaymentPayloadVaultKeys: vi.fn(),
    db: { $transaction: vi.fn() },
    receive: vi.fn(),
    inboxFactory: vi.fn(),
  };
});

vi.mock("@/lib/safepay/config", () => ({
  loadSafepayConfig: mocks.loadSafepayConfig,
  loadSafepayWebhookSecret: mocks.loadSafepayWebhookSecret,
  SafepayConfigurationError: mocks.TestSafepayConfigurationError,
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/payments/vault-env", () => ({ loadPaymentPayloadVaultKeys: mocks.loadPaymentPayloadVaultKeys }));
vi.mock("@/services/payment-webhook.service", () => ({
  createPaymentWebhookService: mocks.inboxFactory,
}));

import { POST } from "@/app/api/webhooks/safepay/route";

const body = Buffer.from('{"type":"payment.succeeded","data":{}}');

function request(overrides: { body?: Buffer | null; signature?: string } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (overrides.signature !== null) headers.set("X-SFPY-SIGNATURE", overrides.signature ?? "a".repeat(128));
  return new Request("http://localhost/api/webhooks/safepay", {
    method: "POST", headers,
    body: overrides.body === null ? undefined : new Uint8Array(overrides.body ?? body),
  });
}

describe("Safepay webhook delivery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSafepayConfig.mockReturnValue(mocks.config);
    mocks.loadSafepayWebhookSecret.mockReturnValue("synthetic-webhook-secret-0123456789abcdef");
    mocks.loadPaymentPayloadVaultKeys.mockReturnValue({
      activeKeyId: "primary", keyRing: new Map([["primary", new Uint8Array(32)]]),
    });
    mocks.inboxFactory.mockReturnValue({ receive: mocks.receive });
    mocks.receive.mockResolvedValue({ kind: "stored", eventId: "event-1" });
  });

  it("stores a delivery and acknowledges with 200 within the documented window", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, code: "stored" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.receive).toHaveBeenCalledWith(expect.objectContaining({
      provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account", channel: "WEBHOOK",
    }));
  });

  it("acknowledges duplicates and quarantined events with 200 to stop redelivery", async () => {
    for (const kind of ["duplicate", "quarantined", "conflict"] as const) {
      mocks.receive.mockResolvedValue({ kind, eventId: "event-1" });
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect((await response.json()).code).toBe(kind);
    }
  });

  it("sends 503 when unconfigured so deliveries stay in the provider retry queue", async () => {
    mocks.loadSafepayWebhookSecret.mockReturnValue(null);
    expect((await POST(request())).status).toBe(503);
    mocks.loadSafepayConfig.mockImplementation(() => { throw new mocks.TestSafepayConfigurationError(); });
    expect((await POST(request())).status).toBe(503);
  });

  it("sends 503 when payload custody keys are missing instead of accepting unsecured bytes", async () => {
    mocks.loadPaymentPayloadVaultKeys.mockReturnValue(null);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it("maps blocked outcomes to the documented retry semantics", async () => {
    mocks.receive.mockResolvedValue({ kind: "blocked", code: "INVALID_INPUT" });
    expect((await POST(request())).status).toBe(400);
    mocks.receive.mockResolvedValue({ kind: "blocked", code: "PERSISTENCE_UNAVAILABLE" });
    expect((await POST(request())).status).toBe(503);
    mocks.receive.mockRejectedValue(new Error("storage down"));
    expect((await POST(request())).status).toBe(503);
  });

  it("rejects oversized payloads with a terminal 413", async () => {
    expect((await POST(request({ body: Buffer.alloc(1_048_577) }))).status).toBe(413);
  });

  it("binds only documented Safepay headers into verification input", async () => {
    const headers = new Headers({ "Content-Type": "application/json",
      "X-SFPY-SIGNATURE": "a".repeat(128), "X-SFPY-Event-Id": "evt_1", "X-Custom-Junk": "junk" });
    await POST(new Request("http://localhost/api/webhooks/safepay", { method: "POST", headers, body }));
    const input = mocks.receive.mock.calls[0][0];
    expect(Object.keys(input.headers).sort()).toEqual(["content-type", "x-sfpy-event-id", "x-sfpy-signature"]);
  });
});
