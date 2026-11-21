// Stage 3 API audit — service-level tests for the error-code mappings
// that routes depend on: refund contention → TRANSIENT (M-8) and
// payment-review on a missing order → ORDER_NOT_FOUND (L-3). The real
// service modules run against stub databases, so no rows are created and
// no provider is contacted.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { $transaction: vi.fn() } }));
vi.mock("@/services/admin-audit.service", () => ({
  ADMIN_AUDIT_ACTIONS: { PAYMENT_REVIEW_HOLD_RESOLVED: "PAYMENT_REVIEW_HOLD_RESOLVED" },
  adminAuditContext: vi.fn(() => ({ actor: "test-admin" })),
  recordAdminAudit: vi.fn(async () => undefined),
  recordAdminAuditBestEffort: vi.fn(async () => undefined),
}));

import { createPaymentRefundService, REFUND_SERVICE_OPTIONS } from "@/services/payment-refund.service";
import { createPaymentReviewService } from "@/services/payment-review.service";

describe("M-8 — refund service contention code", () => {
  it("maps repeated P2034 contention to TRANSIENT, not INVALID_INPUT", async () => {
    const database = {
      $transaction: vi.fn(async () => {
        throw { code: "P2034", message: "Transaction failed due to a write conflict" };
      }),
    };
    const refunds = createPaymentRefundService(database as never, null, {
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
      ...REFUND_SERVICE_OPTIONS,
    });
    const result = await refunds.requestRefund({
      paymentId: "payment-1",
      requestedByUserId: "admin-1",
    });
    expect(result).toEqual({ kind: "rejected", code: "TRANSIENT" });
    // Three attempts (initial + 2 retries) before giving up as TRANSIENT.
    expect(database.$transaction).toHaveBeenCalledTimes(3);
  });

  it("maps P2024 pool timeouts to TRANSIENT as well", async () => {
    const database = {
      $transaction: vi.fn(async () => {
        throw { code: "P2024", message: "Timed out fetching a new connection from the pool" };
      }),
    };
    const refunds = createPaymentRefundService(database as never, null, {
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
      ...REFUND_SERVICE_OPTIONS,
    });
    const result = await refunds.requestRefund({
      paymentId: "payment-1",
      requestedByUserId: "admin-1",
    });
    expect(result).toEqual({ kind: "rejected", code: "TRANSIENT" });
  });

  it("still maps genuinely invalid input to INVALID_INPUT", async () => {
    const database = { $transaction: vi.fn() };
    const refunds = createPaymentRefundService(database as never, null, {
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
      ...REFUND_SERVICE_OPTIONS,
    });
    const result = await refunds.requestRefund({
      paymentId: "payment-1",
      amountMinor: BigInt(0),
      requestedByUserId: "admin-1",
    });
    expect(result).toEqual({ kind: "rejected", code: "INVALID_INPUT" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});

describe("L-3 — payment-review service missing-order code", () => {
  it("returns ORDER_NOT_FOUND for a nonexistent order, not NOT_ELIGIBLE", async () => {
    const tx = { order: { findUnique: vi.fn(async () => null) } };
    const database = { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
    const service = createPaymentReviewService(database as never);
    const result = await service.resolvePaymentReviewHold("missing-order", "NOT_CAPTURED");
    expect(result).toEqual({ ok: false, code: "ORDER_NOT_FOUND" });
  });

  it("still returns NOT_ELIGIBLE for an existing but ineligible order", async () => {
    const tx = {
      order: {
        findUnique: vi.fn(async () => ({
          paymentFlowVersion: 1,
          paymentMethod: "COD",
          status: "CONFIRMED",
          paymentStatus: "PENDING",
          acceptedPaymentId: null,
          checkoutClosedAt: new Date(),
          paymentReviewStatus: "NOT_REQUIRED",
        })),
      },
    };
    const database = { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
    const service = createPaymentReviewService(database as never);
    const result = await service.resolvePaymentReviewHold("order-1", "NOT_CAPTURED");
    expect(result).toEqual({ ok: false, code: "NOT_ELIGIBLE" });
  });
});
