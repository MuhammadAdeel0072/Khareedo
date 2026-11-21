import { beforeEach, describe, expect, it, vi } from "vitest";

const monitoringMocks = vi.hoisted(() => ({
  captureError: vi.fn(),
  capturePaymentAlert: vi.fn(),
}));

vi.mock("@/lib/error-monitoring", () => monitoringMocks);
vi.mock("@/lib/performance-timing", () => ({
  getPerformanceRequestId: () => "req-test",
}));

import { AuthError } from "@/lib/auth-guard";
import { handleRoute } from "@/lib/api";
import { createPaymentMaintenanceWorker } from "@/services/payment-maintenance-worker.service";
import {
  alertOnBlockedInboxOutcomes,
  alertOnProviderFetchFailures,
  alertOnRefundReconciliationOutcomes,
} from "@/services/payment-maintenance.service";
import type { MaintenanceAction, MaintenanceRunResult } from "@/services/payment-maintenance.service";

describe("handleRoute error capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures unexpected errors centrally and still returns a generic 500", async () => {
    const response = await handleRoute(async () => {
      throw new Error("db password=hunter2 exploded");
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error: "Something went wrong. Please try again.",
    });
    expect(monitoringMocks.captureError).toHaveBeenCalledTimes(1);
    expect(monitoringMocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      { operation: "api-route", requestId: "req-test" },
    );
    // The raw error (with its secret) is passed to the sanitising capture,
    // never into the response or a raw log line.
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("does not capture auth errors", async () => {
    const response = await handleRoute(async () => {
      throw new AuthError("Not signed in.", 401);
    });
    expect(response.status).toBe(401);
    expect(monitoringMocks.captureError).not.toHaveBeenCalled();
  });

  it("does not capture successful requests", async () => {
    const response = await handleRoute(async () => Response.json({ ok: true }));
    expect(response.status).toBe(200);
    expect(monitoringMocks.captureError).not.toHaveBeenCalled();
  });
});

describe("worker failure alert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alerts WORKER_FAILURE when a sweep throws, and never throws itself", async () => {
    const run = vi.fn(async (): Promise<MaintenanceRunResult> => {
      throw new Error("Simulated temporary outage");
    });
    const worker = createPaymentMaintenanceWorker({ run }, { log: () => {} });
    await expect(worker.sweepOnce()).resolves.toBeUndefined();
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledTimes(1);
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledWith("WORKER_FAILURE", {
      operation: "payment-maintenance-sweep",
      code: "SWEEP_FAILED",
    });
  });

  it("does not alert when the sweep succeeds", async () => {
    const run = vi.fn(async (action: MaintenanceAction, batch: number): Promise<MaintenanceRunResult> => {
      if (action === "expire_reservations") return { action, batch, released: 0, reviewRequired: 0, settled: 0, failed: 0 };
      if (action === "process_webhook_inbox") return { action, batch, considered: 0, outcomes: [] };
      if (action === "reconcile_due_payments") return { action, batch, considered: 0, outcomes: [] };
      return { action: "reconcile_refunds", batch, considered: 0, released: 0, outcomes: [] };
    });
    const worker = createPaymentMaintenanceWorker({ run }, { log: () => {} });
    await worker.sweepOnce();
    expect(monitoringMocks.capturePaymentAlert).not.toHaveBeenCalled();
  });
});

describe("runner alert decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alerts once for blocked inbox outcomes, with the first event and a count", () => {
    alertOnBlockedInboxOutcomes([
      { eventId: "evt-1", result: "settled" },
      { eventId: "evt-2", result: "blocked" },
      { eventId: "evt-3", result: "blocked" },
    ]);
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledTimes(1);
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledWith("WEBHOOK_FAILURE", {
      operation: "process-webhook-inbox",
      code: "INBOX_PROCESSING_BLOCKED",
      count: 2,
      eventId: "evt-2",
    });
  });

  it("does not alert when no inbox outcome is blocked", () => {
    alertOnBlockedInboxOutcomes([
      { eventId: "evt-1", result: "settled" },
      { eventId: "evt-2", result: "review_required" },
    ]);
    expect(monitoringMocks.capturePaymentAlert).not.toHaveBeenCalled();
  });

  it("alerts PAYMENT_FAILURE for failed refund submissions and RECONCILIATION_FAILURE for fetch failures", () => {
    alertOnRefundReconciliationOutcomes([
      { refundId: "r-1", disposition: "submitted", outcome: "submitted" },
      { refundId: "r-2", disposition: "submitted", outcome: "failed", code: "PROVIDER_DECLINED" },
      { refundId: "r-3", disposition: "provider_fetch_failed", code: "FETCH_TIMEOUT" },
    ]);
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledTimes(2);
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledWith("PAYMENT_FAILURE", {
      operation: "reconcile-refunds",
      code: "PROVIDER_DECLINED",
      count: 1,
    });
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledWith("RECONCILIATION_FAILURE", {
      operation: "reconcile-refunds",
      code: "FETCH_TIMEOUT",
      count: 1,
    });
  });

  it("does not alert for clean refund reconciliation outcomes", () => {
    alertOnRefundReconciliationOutcomes([
      { refundId: "r-1", disposition: "submitted", outcome: "submitted" },
      { refundId: "r-2", disposition: "observed", outcome: "recorded" },
    ]);
    expect(monitoringMocks.capturePaymentAlert).not.toHaveBeenCalled();
  });

  it("alerts RECONCILIATION_FAILURE for provider fetch failures, with identifiers and count", () => {
    alertOnProviderFetchFailures(
      [
        { paymentId: "pay-1", outcome: "settled" },
        { paymentId: "pay-2", outcome: "provider_fetch_failed", code: "FETCH_TIMEOUT" },
        { paymentId: "pay-3", outcome: "provider_fetch_failed", code: "FETCH_TIMEOUT" },
      ],
      "reconcile-due-payments",
    );
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledTimes(1);
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledWith("RECONCILIATION_FAILURE", {
      operation: "reconcile-due-payments",
      code: "FETCH_TIMEOUT",
      count: 2,
      paymentId: "pay-2",
    });
  });

  it("alerts verify-order-payment fetch failures with the order id", () => {
    alertOnProviderFetchFailures(
      [{ paymentId: "pay-9", orderId: "ord-9", outcome: "provider_fetch_failed", code: "NETWORK_ERROR" }],
      "verify-order-payment",
    );
    expect(monitoringMocks.capturePaymentAlert).toHaveBeenCalledWith("RECONCILIATION_FAILURE", {
      operation: "verify-order-payment",
      code: "NETWORK_ERROR",
      count: 1,
      paymentId: "pay-9",
      orderId: "ord-9",
    });
  });

  it("does not alert when no reconciliation outcome failed to fetch", () => {
    alertOnProviderFetchFailures(
      [{ paymentId: "pay-1", outcome: "settled" }],
      "reconcile-due-payments",
    );
    expect(monitoringMocks.capturePaymentAlert).not.toHaveBeenCalled();
  });
});
