import { describe, expect, it, vi } from "vitest";
import {
  createPaymentVerificationService,
  fetchRetryDelayMs,
  type PaymentDatabase,
} from "@/services/payment-verification.service";
import type { SafepayConfig } from "@/lib/safepay/config";

const config: SafepayConfig = {
  environment: "sandbox",
  apiOrigin: "https://sandbox.api.getsafepay.com",
  checkoutUrl: "https://sandbox.api.getsafepay.com/embedded/",
  entryMode: "flex",
  merchantAccountRef: "synthetic-account",
  siteOrigin: "https://shop.example.invalid",
  timeoutMs: 10000,
  merchantApiKey: () => "synthetic-public",
  requestHeaders: () => new Headers(),
  signReturnState: () => Buffer.alloc(32),
  toJSON: () => ({}),
};

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    trackerToken: "TCKR-1",
    lastReconcileAt: null,
    reconcileAttempts: 0,
    order: {
      id: "order-1", paymentFlowVersion: 1, paymentMethod: "ONLINE",
      status: "PENDING", paymentStatus: "PENDING", checkoutClosedAt: null,
      acceptedPaymentId: null, paymentReviewStatus: "CLEAR",
    },
    ...overrides,
  };
}

function deps(options: {
  row: Record<string, unknown> | null;
  fetched?: { kind: "fetched"; status: number; json: unknown; bodyBytes: Uint8Array } | { kind: "failed"; code: string };
  observed?: unknown;
  now?: Date;
  minIntervalMs?: number;
}) {
  const payment = {
    findFirst: vi.fn().mockResolvedValue(options.row),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const provider = { fetchTracker: vi.fn().mockResolvedValue(options.fetched ?? { kind: "fetched", status: 200, json: {}, bodyBytes: new Uint8Array([1]) }) };
  const reconciliation = { observe: vi.fn().mockResolvedValue(options.observed ?? { kind: "settled" }) };
  const now = options.now ?? new Date("2026-11-09T10:00:00Z");
  return {
    service: createPaymentVerificationService({
      database: { payment } as unknown as PaymentDatabase,
      config,
      provider,
      reconciliation: reconciliation as never,
      now: () => now,
      minIntervalMs: options.minIntervalMs,
    }),
    payment, provider, reconciliation, now,
  };
}

describe("Targeted Safepay payment verification", () => {
  it("skips unknown or ineligible payments without any provider call", async () => {
    const missing = deps({ row: null });
    await expect(missing.service.verifyPaymentNow("pay-x")).resolves.toEqual({ kind: "skipped", code: "NOT_ELIGIBLE" });
    expect(missing.provider.fetchTracker).not.toHaveBeenCalled();

    const accepted = deps({ row: eligibleRow({ order: { id: "order-1", paymentFlowVersion: 1, paymentMethod: "ONLINE", status: "PENDING", paymentStatus: "PENDING", checkoutClosedAt: null, acceptedPaymentId: "pay-9", paymentReviewStatus: "CLEAR" } }) });
    await expect(accepted.service.verifyPaymentNow("pay-1")).resolves.toEqual({ kind: "skipped", code: "NOT_ELIGIBLE" });
    expect(accepted.provider.fetchTracker).not.toHaveBeenCalled();

    const closed = deps({ row: eligibleRow({ order: { id: "order-1", paymentFlowVersion: 1, paymentMethod: "ONLINE", status: "CANCELLED", paymentStatus: "PENDING", checkoutClosedAt: new Date(), acceptedPaymentId: null, paymentReviewStatus: "CLEAR" } }) });
    await expect(closed.service.verifyPaymentNow("pay-1")).resolves.toEqual({ kind: "skipped", code: "NOT_ELIGIBLE" });

    const malformed = deps({ row: eligibleRow() });
    await expect(malformed.service.verifyPaymentNow("bad id with spaces")).resolves.toEqual({ kind: "skipped", code: "NOT_ELIGIBLE" });
    expect(malformed.payment.findFirst).not.toHaveBeenCalled();
  });

  it("enforces the refresh-spam backoff window", async () => {
    const at = new Date("2026-11-09T10:00:00Z");
    const d = deps({ row: eligibleRow({ lastReconcileAt: new Date(at.getTime() - 5_000) }), now: at });
    await expect(d.service.verifyPaymentNow("pay-1")).resolves.toEqual({ kind: "skipped", code: "BACKOFF" });
    expect(d.provider.fetchTracker).not.toHaveBeenCalled();
  });

  it("feeds the exact provider bytes into the reconciliation channel and returns its outcome", async () => {
    const bodyBytes = new Uint8Array([7, 8, 9]);
    const d = deps({
      row: eligibleRow(),
      fetched: { kind: "fetched", status: 200, json: { data: { tracker: {} } }, bodyBytes },
      observed: { kind: "settled" },
    });
    await expect(d.service.verifyPaymentNow("pay-1")).resolves.toEqual({ kind: "settled" });
    expect(d.provider.fetchTracker).toHaveBeenCalledWith({ trackerToken: "TCKR-1" });
    expect(d.reconciliation.observe).toHaveBeenCalledWith(expect.objectContaining({
      provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
      channel: "RECONCILIATION",
    }));
    const input = d.reconciliation.observe.mock.calls[0][0];
    expect(Array.from(input.body)).toEqual([7, 8, 9]);
    expect(d.payment.updateMany).not.toHaveBeenCalled();
  });

  it("schedules capped retry backoff on transport failure and never invents finality", async () => {
    const at = new Date("2026-11-09T10:00:00Z");
    const d = deps({
      row: eligibleRow({ reconcileAttempts: 2 }),
      fetched: { kind: "failed", code: "TIMEOUT" },
      now: at,
    });
    const outcome = await d.service.verifyPaymentNow("pay-1");
    expect(outcome).toEqual({ kind: "provider_fetch_failed", code: "TIMEOUT" });
    expect(d.reconciliation.observe).not.toHaveBeenCalled();
    expect(d.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", status: "PENDING", reconcileStatus: { in: ["PENDING", "UNCERTAIN"] } },
      data: expect.objectContaining({
        reconcileAttempts: { increment: 1 },
        lastErrorCode: "TIMEOUT",
        lastErrorAt: at,
        lastReconcileAt: at,
        nextReconcileAt: new Date(at.getTime() + fetchRetryDelayMs(2)),
      }),
    });
    // Scheduling-only write: no financial or lifecycle field is touched.
    const data = d.payment.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      ["lastErrorAt", "lastErrorCode", "lastReconcileAt", "nextReconcileAt", "reconcileAttempts", "version"]);
  });

  it("grows the retry delay exponentially and caps it at 15 minutes", () => {
    expect(fetchRetryDelayMs(1)).toBe(60_000);
    expect(fetchRetryDelayMs(2)).toBe(120_000);
    expect(fetchRetryDelayMs(5)).toBe(900_000);
    expect(fetchRetryDelayMs(50)).toBe(900_000);
  });
});
