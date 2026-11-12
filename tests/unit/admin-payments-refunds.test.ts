import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level tests for the admin refund API. The service layer is mocked: these tests
// pin the HTTP contract (authorization, sandbox code gate, validation, status mapping,
// rate limiting, serialization) — not the ledger semantics, which the integration suite covers.
const mocks = vi.hoisted(() => ({
  db: { $transaction: vi.fn() },
  requireAdmin: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true, retryAfterSec: 0 })),
  loadSafepayConfig: vi.fn(),
  loadSafepayApiOnlyConfig: vi.fn(),
  providerFactory: vi.fn(),
  provider: { submitRefund: vi.fn(), fetchTracker: vi.fn() },
  refundService: {
    requestRefund: vi.fn(),
    getRefund: vi.fn(),
    listRefunds: vi.fn(),
    dueForReconciliation: vi.fn(),
    abandonStaleSubmission: vi.fn(),
    noteReconcileAttempt: vi.fn(),
  },
  refundFactory: vi.fn(),
  inboxFactory: vi.fn(),
  reconciliationFactory: vi.fn(),
  reconciliation: { due: vi.fn(), observe: vi.fn(), reconcileDueRefunds: vi.fn() },
  inbox: { pending: vi.fn(), process: vi.fn() },
  vaultKeys: { activeKeyId: "primary", keyRing: new Map([["primary", new Uint8Array(32)]]) },
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
  loadSafepayApiOnlyConfig: mocks.loadSafepayApiOnlyConfig,
  SafepayConfigurationError: class SafepayConfigurationError extends Error {},
}));
vi.mock("@/lib/safepay/provider", () => ({ createSafepayProvider: mocks.providerFactory }));
vi.mock("@/services/payment-refund.service", () => ({
  createPaymentRefundService: mocks.refundFactory,
}));
vi.mock("@/services/payment-webhook.service", () => ({ createPaymentWebhookService: mocks.inboxFactory }));
vi.mock("@/services/payment-reconciliation.service", () => ({
  createPaymentReconciliationService: mocks.reconciliationFactory,
}));
vi.mock("@/lib/payments/vault-env", () => ({ loadPaymentPayloadVaultKeys: vi.fn(() => mocks.vaultKeys) }));

import { POST, GET } from "@/app/api/admin/payments/refunds/route";
import { GET as GET_ONE } from "@/app/api/admin/payments/refunds/[id]/route";
import { POST as MAINTENANCE_POST } from "@/app/api/admin/payments/maintenance/route";

const sandboxConfig = { environment: "sandbox", merchantAccountRef: "synthetic-account",
  merchantApiKey: () => "synthetic-public", requestHeaders: () => new Headers(),
  signReturnState: () => Buffer.alloc(32), siteOrigin: "https://shop.example.invalid",
  apiOrigin: "https://sandbox.api.getsafepay.com", checkoutUrl: "https://sandbox.api.getsafepay.com/embedded/",
  entryMode: "flex" as const, timeoutMs: 10000, toJSON: () => ({}) };

const refundRow = {
  id: "refund-1", paymentId: "payment-1", amountMinor: BigInt(220000), currency: "PKR",
  type: "FULL", status: "PENDING", initiatedBy: "ADMIN", providerState: "TRACKER_REFUNDED",
  providerReference: null, providerRefundedAt: null, failureCode: null, failureMessage: null,
  lastSubmissionCode: null, reviewReason: null, requestedByUserId: "admin-1",
  requestedAt: new Date(), submittedAt: new Date(), confirmedAt: null, settledAt: null,
  reconcileStatus: "PENDING", reconcileAttempts: 0, version: 2,
  payment: { orderId: "order-1" },
};

function postRequest(payload: unknown) {
  return new Request("http://localhost/api/admin/payments/refunds", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

describe("Admin refund initiation (POST /api/admin/payments/refunds)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSafepayConfig.mockReturnValue(sandboxConfig);
    mocks.loadSafepayApiOnlyConfig.mockReturnValue(sandboxConfig);
    mocks.providerFactory.mockReturnValue(mocks.provider);
    mocks.refundFactory.mockReturnValue(mocks.refundService);
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", email: "a@x.invalid", role: "ADMIN" });
  });

  it("creates a full refund for an authorized administrator and serializes the ledger row", async () => {
    mocks.refundService.requestRefund.mockResolvedValue({ kind: "created", refundId: "refund-1",
      submission: { kind: "submitted", providerState: "TRACKER_REFUNDED" } });
    mocks.refundService.getRefund.mockResolvedValue(refundRow);
    const response = await POST(postRequest({ paymentId: "payment-1" }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.refund).toMatchObject({ id: "refund-1", amountMinor: "220000", status: "PENDING", orderId: "order-1" });
    expect(body.result).toMatchObject({ kind: "created", submission: { kind: "submitted" } });
    expect(mocks.refundService.requestRefund).toHaveBeenCalledWith({ paymentId: "payment-1",
      requestedByUserId: "admin-1" }); // no amountMinor → full remaining balance
  });

  it("passes a validated minor-unit amount for partial refunds", async () => {
    mocks.refundService.requestRefund.mockResolvedValue({ kind: "created", refundId: "refund-1",
      submission: { kind: "uncertain", code: "TIMEOUT" } });
    mocks.refundService.getRefund.mockResolvedValue(refundRow);
    const response = await POST(postRequest({ paymentId: "payment-1", amountMinor: 5000,
      idempotencyKey: "abcd1234abcd1234" }));
    expect(response.status).toBe(201);
    expect(mocks.refundService.requestRefund).toHaveBeenCalledWith({ paymentId: "payment-1",
      amountMinor: BigInt(5000), idempotencyKey: "abcd1234abcd1234", requestedByUserId: "admin-1" });
  });

  it("rejects unauthenticated callers", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthError("Please sign in to continue", 401));
    expect((await POST(postRequest({ paymentId: "payment-1" }))).status).toBe(401);
  });

  it("rejects non-admin callers with 403", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthError("Administrator access required", 403));
    expect((await POST(postRequest({ paymentId: "payment-1" }))).status).toBe(403);
  });

  it("enforces the sandbox-only code gate for refunds", async () => {
    mocks.loadSafepayConfig.mockReturnValue({ ...sandboxConfig, environment: "production" });
    const response = await POST(postRequest({ paymentId: "payment-1" }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("REFUNDS_SANDBOX_ONLY");
    expect(mocks.refundService.requestRefund).not.toHaveBeenCalled();
  });

  it("returns 422 for invalid bodies and never reaches the service", async () => {
    for (const payload of [{}, { paymentId: "bad id!" }, { paymentId: "payment-1", amountMinor: 0 },
      { paymentId: "payment-1", amountMinor: -5 }, { paymentId: "payment-1", amountMinor: 1.5 },
      { paymentId: "payment-1", idempotencyKey: "short" }, { paymentId: "payment-1", extra: true }]) {
      const response = await POST(postRequest(payload));
      expect(response.status).toBe(422);
    }
    expect(mocks.refundService.requestRefund).not.toHaveBeenCalled();
  });

  it("maps service rejections to 404/409 without leaking internals", async () => {
    mocks.refundService.requestRefund.mockResolvedValue({ kind: "rejected", code: "PAYMENT_NOT_FOUND" });
    expect((await POST(postRequest({ paymentId: "payment-1" }))).status).toBe(404);
    mocks.refundService.requestRefund.mockResolvedValue({ kind: "rejected", code: "REFUND_EXCEEDS_REMAINING" });
    const conflict = await POST(postRequest({ paymentId: "payment-1", amountMinor: 1 }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).not.toContain("secret");
  });

  it("returns parked review requests with their audit row", async () => {
    mocks.refundService.requestRefund.mockResolvedValue({ kind: "review_required",
      refundId: "refund-1", reason: "REFUND_WINDOW_REVERSAL_24H" });
    mocks.refundService.getRefund.mockResolvedValue({ ...refundRow, status: "REVIEW_REQUIRED",
      reviewReason: "REFUND_WINDOW_REVERSAL_24H" });
    const response = await POST(postRequest({ paymentId: "payment-1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toMatchObject({ kind: "review_required", reason: "REFUND_WINDOW_REVERSAL_24H" });
    expect(body.refund.status).toBe("REVIEW_REQUIRED");
  });

  it("rate limits initiation per administrator", async () => {
    mocks.rateLimit.mockReturnValueOnce({ ok: false, retryAfterSec: 42 });
    const response = await POST(postRequest({ paymentId: "payment-1" }));
    expect(response.status).toBe(429);
  });

  it("returns idempotent replays of an existing operation", async () => {
    mocks.refundService.requestRefund.mockResolvedValue({ kind: "existing", refundId: "refund-1",
      status: "PENDING" });
    mocks.refundService.getRefund.mockResolvedValue(refundRow);
    const response = await POST(postRequest({ paymentId: "payment-1", idempotencyKey: "abcd1234abcd1234" }));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ kind: "existing" });
  });
});

describe("Admin refund monitoring (GET)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refundFactory.mockReturnValue(mocks.refundService);
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", email: "a@x.invalid", role: "ADMIN" });
  });

  it("lists refund history with filters", async () => {
    mocks.refundService.listRefunds.mockResolvedValue([refundRow]);
    const response = await GET(new Request("http://localhost/api/admin/payments/refunds?orderId=order-1&status=PENDING"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.refunds).toHaveLength(1);
    expect(body.refunds[0]).toMatchObject({ id: "refund-1", amountMinor: "220000" });
    expect(mocks.refundService.listRefunds).toHaveBeenCalledWith({ orderId: "order-1", status: "PENDING" }, 50);
  });

  it("rejects invalid filters with 422", async () => {
    const response = await GET(new Request("http://localhost/api/admin/payments/refunds?status=NOPE"));
    expect(response.status).toBe(422);
    expect(mocks.refundService.listRefunds).not.toHaveBeenCalled();
  });

  it("returns one refund by id and 404 for unknown ids", async () => {
    mocks.refundService.getRefund.mockResolvedValue(refundRow);
    const found = await GET_ONE(new Request("http://localhost/api/admin/payments/refunds/refund-1"),
      { params: Promise.resolve({ id: "refund-1" }) });
    expect(found.status).toBe(200);
    expect((await found.json()).refund).toMatchObject({ id: "refund-1" });
    mocks.refundService.getRefund.mockResolvedValue(null);
    const missing = await GET_ONE(new Request("http://localhost/api/admin/payments/refunds/missing"),
      { params: Promise.resolve({ id: "missing" }) });
    expect(missing.status).toBe(404);
  });
});

describe("Maintenance trigger: reconcile_refunds action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSafepayConfig.mockReturnValue(sandboxConfig);
    mocks.loadSafepayApiOnlyConfig.mockReturnValue(sandboxConfig);
    mocks.providerFactory.mockReturnValue(mocks.provider);
    mocks.refundFactory.mockReturnValue(mocks.refundService);
    mocks.inboxFactory.mockReturnValue(mocks.inbox);
    mocks.reconciliationFactory.mockReturnValue(mocks.reconciliation);
    mocks.requireAdmin.mockResolvedValue({ id: "admin-1", email: "a@x.invalid", role: "ADMIN" });
  });

  it("runs the bounded refund sweep through the reconciliation service", async () => {
    mocks.reconciliation.reconcileDueRefunds.mockResolvedValue({ considered: 1,
      outcomes: [{ refundId: "refund-1", disposition: "submitted", outcome: "submitted" }] });
    const response = await MAINTENANCE_POST(new Request("http://localhost/api/admin/payments/maintenance", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reconcile_refunds", limit: 5 }) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, action: "reconcile_refunds", batch: 5, considered: 1 });
    expect(mocks.reconciliation.reconcileDueRefunds).toHaveBeenCalledWith(mocks.refundService, mocks.provider,
      { environment: "sandbox", merchantAccountRef: "synthetic-account" }, 5);
  });

  it("keeps the refund sweep behind the admin session guard", async () => {
    mocks.requireAdmin.mockRejectedValue(new AuthError("Administrator access required", 403));
    const response = await MAINTENANCE_POST(new Request("http://localhost/api/admin/payments/maintenance", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reconcile_refunds" }) }));
    expect(response.status).toBe(403);
    expect(mocks.reconciliation.reconcileDueRefunds).not.toHaveBeenCalled();
  });
});

import { AuthError } from "@/lib/auth-guard";
