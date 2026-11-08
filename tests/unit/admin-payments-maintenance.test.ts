import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { $transaction: vi.fn() },
  requireAdmin: vi.fn(),
  rateLimit: vi.fn(),
  config: { environment: "sandbox", merchantAccountRef: "synthetic-account",
    merchantApiKey: () => "synthetic-public", requestHeaders: () => new Headers(),
    signReturnState: () => Buffer.alloc(32), siteOrigin: "https://shop.example.invalid",
    apiOrigin: "https://sandbox.api.getsafepay.com", checkoutUrl: "https://sandbox.api.getsafepay.com/embedded/",
    entryMode: "flex" as const, timeoutMs: 10000, toJSON: () => ({}), },
  loadSafepayConfig: vi.fn(),
  loadPaymentPayloadVaultKeys: vi.fn(),
  provider: { fetchTracker: vi.fn() },
  providerFactory: vi.fn(),
  reservations: { expireBatch: vi.fn() },
  reservationFactory: vi.fn(),
  inbox: { pending: vi.fn(), process: vi.fn() },
  inboxFactory: vi.fn(),
  reconciliation: { due: vi.fn(), observe: vi.fn() },
  reconciliationFactory: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/auth-guard", () => ({
  requireAdmin: mocks.requireAdmin,
  AuthError: class AuthError extends Error {
    status: number;
    constructor(message: string, status = 401) { super(message); this.status = status; }
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/safepay/config", () => ({
  loadSafepayConfig: mocks.loadSafepayConfig,
  SafepayConfigurationError: class SafepayConfigurationError extends Error {},
}));
vi.mock("@/lib/safepay/provider", () => ({ createSafepayProvider: mocks.providerFactory }));
vi.mock("@/lib/payments/vault-env", () => ({ loadPaymentPayloadVaultKeys: mocks.loadPaymentPayloadVaultKeys }));
vi.mock("@/services/safepay-reservations.service", () => ({
  createSafepayReservationService: mocks.reservationFactory,
}));
vi.mock("@/services/payment-webhook.service", () => ({
  createPaymentWebhookService: mocks.inboxFactory,
}));
vi.mock("@/services/payment-reconciliation.service", () => ({
  createPaymentReconciliationService: mocks.reconciliationFactory,
}));

import { POST } from "@/app/api/admin/payments/maintenance/route";

function request(payload: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/admin/payments/maintenance", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("Admin payments maintenance trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SAFEPAY_MAINTENANCE_TOKEN;
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    mocks.loadPaymentPayloadVaultKeys.mockReturnValue({
      activeKeyId: "primary", keyRing: new Map([["primary", new Uint8Array(32)]]),
    });
    mocks.reservationFactory.mockReturnValue(mocks.reservations);
    mocks.reservations.expireBatch.mockResolvedValue([]);
    mocks.inboxFactory.mockReturnValue(mocks.inbox);
    mocks.reconciliationFactory.mockReturnValue(mocks.reconciliation);
    mocks.providerFactory.mockReturnValue(mocks.provider);
  });

  it("requires an admin session", async () => {
    const { AuthError } = await import("@/lib/auth-guard");
    mocks.requireAdmin.mockRejectedValue(new AuthError("Please sign in", 401));
    const response = await POST(request({ action: "expire_reservations" }));
    expect(response.status).toBe(401);
    expect(mocks.reservationFactory).not.toHaveBeenCalled();
  });

  it("enforces the optional shared maintenance token with constant-time comparison", async () => {
    process.env.SAFEPAY_MAINTENANCE_TOKEN = "synthetic-maintenance-token-0123456789";
    expect((await POST(request({ action: "expire_reservations" }))).status).toBe(403);
    expect((await POST(request({ action: "expire_reservations" },
      { "x-khd-maintenance-token": "wrong-token-0123456789abcdef" }))).status).toBe(403);
    const ok = await POST(request({ action: "expire_reservations", limit: 3 },
      { "x-khd-maintenance-token": "synthetic-maintenance-token-0123456789" }));
    expect(ok.status).toBe(200);
    expect(mocks.reservations.expireBatch).toHaveBeenCalledWith(3);
  });

  it("rate limits and rejects unknown actions with 422", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 30 });
    expect((await POST(request({ action: "expire_reservations" }))).status).toBe(429);
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    expect((await POST(request({ action: "delete_everything" }))).status).toBe(422);
    expect((await POST(request({ action: "expire_reservations", limit: 500 }))).status).toBe(422);
  });

  it("drains the webhook inbox within the bounded batch", async () => {
    mocks.inbox.pending.mockResolvedValue([{ id: "evt-1" }, { id: "evt-2" }]);
    mocks.inbox.process.mockResolvedValue({ kind: "settled" });
    const response = await POST(request({ action: "process_webhook_inbox", limit: 2 }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.considered).toBe(2);
    expect(payload.outcomes).toEqual([
      { eventId: "evt-1", result: "settled" }, { eventId: "evt-2", result: "settled" },
    ]);
  });

  it("reconciles due payments through the documented reporter fetch", async () => {
    mocks.reconciliation.due.mockResolvedValue([
      { id: "pay-1", provider: "SAFEPAY", trackerToken: "TCKR_OK" },
      { id: "pay-2", provider: "SAFEPAY", trackerToken: null },
    ]);
    mocks.provider.fetchTracker.mockResolvedValue({ kind: "fetched", status: 200, json: {}, bodyBytes: new Uint8Array(1) });
    mocks.reconciliation.observe.mockResolvedValue({ kind: "settled" });
    mocks.loadSafepayConfig.mockReturnValue(mocks.config);
    const response = await POST(request({ action: "reconcile_due_payments" }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.considered).toBe(2);
    // A due row without a bound tracker has nothing to look up; it is skipped without error.
    expect(payload.outcomes).toEqual([{ paymentId: "pay-1", outcome: "settled" }]);
    expect(mocks.provider.fetchTracker).toHaveBeenCalledWith({ trackerToken: "TCKR_OK" });
    expect(mocks.reconciliation.observe).toHaveBeenCalledWith(expect.objectContaining({
      channel: "RECONCILIATION", provider: "SAFEPAY", environment: "sandbox",
    }));
  });

  it("reports provider fetch failures without inventing evidence", async () => {
    mocks.reconciliation.due.mockResolvedValue([{ id: "pay-1", provider: "SAFEPAY", trackerToken: "TCKR_OK" }]);
    mocks.provider.fetchTracker.mockResolvedValue({ kind: "failed", code: "HTTP_ERROR", httpStatus: 404 });
    mocks.loadSafepayConfig.mockReturnValue(mocks.config);
    const response = await POST(request({ action: "reconcile_due_payments" }));
    const payload = await response.json();
    expect(payload.outcomes[0]).toEqual({ paymentId: "pay-1", outcome: "provider_fetch_failed", code: "HTTP_ERROR" });
    expect(mocks.reconciliation.observe).not.toHaveBeenCalled();
  });
});
