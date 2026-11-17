import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  receive: vi.fn(),
  capturePaymentAlert: vi.fn(),
  captureError: vi.fn(),
  SafepayConfigurationError: class SafepayConfigurationError extends Error {
    constructor() {
      super("Safepay is not configured.");
      this.name = "SafepayConfigurationError";
    }
  },
}));

vi.mock("@/lib/safepay/config", () => ({
  loadSafepayConfig: () => ({ environment: "sandbox", merchantAccountRef: "m-ref" }),
  loadSafepayWebhookSecret: () => "whsec-test",
  SafepayConfigurationError: mocks.SafepayConfigurationError,
}));
vi.mock("@/lib/payments/vault-env", () => ({
  loadPaymentPayloadVaultKeys: () => ({
    activeKeyId: "primary",
    keyRing: new Map([["primary", new Uint8Array(32)]]),
  }),
}));
vi.mock("@/lib/payments/payload-vault", () => ({
  createPaymentPayloadVault: () => ({}),
}));
vi.mock("@/services/payment-webhook.service", () => ({
  createPaymentWebhookService: () => ({ receive: mocks.receive }),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/error-monitoring", () => ({
  captureError: mocks.captureError,
  capturePaymentAlert: mocks.capturePaymentAlert,
}));

import { POST } from "@/app/api/webhooks/safepay/route";

function webhookRequest() {
  return new Request("http://localhost/api/webhooks/safepay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sfpy-signature": "sig-test",
      "x-sfpy-event-id": "evt-test",
    },
    body: JSON.stringify({ event: "payment.succeeded" }),
  });
}

describe("Safepay webhook route alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alerts WEBHOOK_FAILURE when inbox custody throws, and still returns 503 for retry", async () => {
    mocks.receive.mockRejectedValueOnce(new Error("database down"));
    const response = await POST(webhookRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "PERSISTENCE_UNAVAILABLE" });
    expect(mocks.capturePaymentAlert).toHaveBeenCalledTimes(1);
    expect(mocks.capturePaymentAlert).toHaveBeenCalledWith("WEBHOOK_FAILURE", {
      operation: "webhook-receive",
      code: "PERSISTENCE_UNAVAILABLE",
    });
  });

  it("alerts QUARANTINED while still acknowledging 200 so the provider does not redeliver", async () => {
    mocks.receive.mockResolvedValueOnce({ kind: "quarantined", eventId: "evt-9" });
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, code: "quarantined" });
    expect(mocks.capturePaymentAlert).toHaveBeenCalledWith("WEBHOOK_FAILURE", {
      operation: "webhook-receive",
      code: "QUARANTINED",
      eventId: "evt-9",
    });
  });

  it("alerts CONFLICT while still acknowledging 200", async () => {
    mocks.receive.mockResolvedValueOnce({ kind: "conflict", eventId: "evt-8" });
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(mocks.capturePaymentAlert).toHaveBeenCalledWith("WEBHOOK_FAILURE", {
      operation: "webhook-receive",
      code: "CONFLICT",
      eventId: "evt-8",
    });
  });

  it("does not alert for stored or duplicate deliveries", async () => {
    mocks.receive.mockResolvedValueOnce({ kind: "stored", eventId: "evt-1" });
    const stored = await POST(webhookRequest());
    expect(stored.status).toBe(200);
    mocks.receive.mockResolvedValueOnce({ kind: "duplicate", eventId: "evt-1" });
    const duplicate = await POST(webhookRequest());
    expect(duplicate.status).toBe(200);
    expect(mocks.capturePaymentAlert).not.toHaveBeenCalled();
  });

  it("alerts for blocked deliveries that Safepay must retry, but not for terminal invalid input", async () => {
    mocks.receive.mockResolvedValueOnce({ kind: "blocked", code: "BUSY" });
    const busy = await POST(webhookRequest());
    expect(busy.status).toBe(503);
    expect(mocks.capturePaymentAlert).toHaveBeenCalledWith("WEBHOOK_FAILURE", {
      operation: "webhook-receive",
      code: "BUSY",
    });

    mocks.capturePaymentAlert.mockClear();
    mocks.receive.mockResolvedValueOnce({ kind: "blocked", code: "INVALID_INPUT" });
    const invalid = await POST(webhookRequest());
    expect(invalid.status).toBe(400);
    expect(mocks.capturePaymentAlert).not.toHaveBeenCalled();
  });
});
