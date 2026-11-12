import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  rateLimit: vi.fn(),
  runnerRun: vi.fn(),
  runnerFactory: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({
  requireAdmin: mocks.requireAdmin,
  AuthError: class AuthError extends Error {
    status: number;
    constructor(message: string, status = 401) { super(message); this.status = status; }
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/services/payment-maintenance.service", () => ({
  MAINTENANCE_ACTIONS: ["expire_reservations", "process_webhook_inbox", "reconcile_due_payments", "verify_order_payment"],
  createPaymentMaintenanceRunner: mocks.runnerFactory,
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
    mocks.runnerFactory.mockReturnValue({ run: mocks.runnerRun });
    mocks.runnerRun.mockResolvedValue({ action: "expire_reservations", batch: 25, released: 0, reviewRequired: 0, failed: 0 });
  });

  it("requires an admin session", async () => {
    const { AuthError } = await import("@/lib/auth-guard");
    mocks.requireAdmin.mockRejectedValue(new AuthError("Please sign in", 401));
    const response = await POST(request({ action: "expire_reservations" }));
    expect(response.status).toBe(401);
    expect(mocks.runnerFactory).not.toHaveBeenCalled();
  });

  it("enforces the optional shared maintenance token with constant-time comparison", async () => {
    process.env.SAFEPAY_MAINTENANCE_TOKEN = "synthetic-maintenance-token-0123456789";
    expect((await POST(request({ action: "expire_reservations" }))).status).toBe(403);
    expect((await POST(request({ action: "expire_reservations" },
      { "x-khd-maintenance-token": "wrong-token-0123456789abcdef" }))).status).toBe(403);
    const ok = await POST(request({ action: "expire_reservations", limit: 3 },
      { "x-khd-maintenance-token": "synthetic-maintenance-token-0123456789" }));
    expect(ok.status).toBe(200);
    expect(mocks.runnerRun).toHaveBeenCalledWith("expire_reservations", 3, undefined);
  });

  it("rate limits and rejects unknown actions with 422", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 30 });
    expect((await POST(request({ action: "expire_reservations" }))).status).toBe(429);
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
    expect((await POST(request({ action: "delete_everything" }))).status).toBe(422);
    expect((await POST(request({ action: "expire_reservations", limit: 500 }))).status).toBe(422);
  });

  it("delegates bounded sweeps to the shared maintenance runner", async () => {
    mocks.runnerRun.mockResolvedValue({
      action: "process_webhook_inbox", batch: 2, considered: 2,
      outcomes: [{ eventId: "evt-1", result: "settled" }, { eventId: "evt-2", result: "settled" }],
    });
    const response = await POST(request({ action: "process_webhook_inbox", limit: 2 }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.considered).toBe(2);
    expect(payload.outcomes).toEqual([
      { eventId: "evt-1", result: "settled" }, { eventId: "evt-2", result: "settled" },
    ]);
  });

  it("reports provider fetch failures without inventing evidence", async () => {
    mocks.runnerRun.mockResolvedValue({
      action: "reconcile_due_payments", batch: 25, considered: 1,
      outcomes: [{ paymentId: "pay-1", outcome: "provider_fetch_failed", code: "HTTP_ERROR" }],
    });
    const response = await POST(request({ action: "reconcile_due_payments" }));
    const payload = await response.json();
    expect(payload.outcomes[0]).toEqual({ paymentId: "pay-1", outcome: "provider_fetch_failed", code: "HTTP_ERROR" });
  });

  it("requires an orderId for the targeted verification action", async () => {
    expect((await POST(request({ action: "verify_order_payment" }))).status).toBe(422);
    expect((await POST(request({ action: "verify_order_payment", orderId: "not a valid id!" }))).status).toBe(422);
    expect(mocks.runnerRun).not.toHaveBeenCalled();
    const ok = await POST(request({ action: "verify_order_payment", orderId: "order-1" }));
    expect(ok.status).toBe(200);
    expect(mocks.runnerRun).toHaveBeenCalledWith("verify_order_payment", 25, { orderId: "order-1" });
  });

  it("surfaces runner unavailability codes without leaking internals", async () => {
    mocks.runnerRun.mockResolvedValue({ action: "reconcile_due_payments", blocked: true, code: "SAFEPAY_CONFIGURATION_UNAVAILABLE" });
    const response = await POST(request({ action: "reconcile_due_payments" }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.blocked).toBe(true);
    expect(payload.code).toBe("SAFEPAY_CONFIGURATION_UNAVAILABLE");
  });
});
