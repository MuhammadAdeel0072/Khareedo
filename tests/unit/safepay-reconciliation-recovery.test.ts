import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createPaymentVerificationService } from "@/services/payment-verification.service";

type Deps = Parameters<typeof createPaymentVerificationService>[0];

describe("Safepay provider outage recovery", () => {
  it("respects persisted backoff and recovers after the provider returns", async () => {
    const start = Date.parse("2026-11-12T12:00:00.000Z");
    let currentTime = start;
    let lastReconcileAt: Date | null = null;
    let nextReconcileAt: Date | null = null;
    let attempts = 0;

    const database = {
      payment: {
        findFirst: vi.fn(async () => ({
          id: "test_payment",
          trackerToken: "test_tracker",
          lastReconcileAt,
          nextReconcileAt,
          reconcileAttempts: attempts,
          order: {
            id: "test_order",
            paymentFlowVersion: 1,
            paymentMethod: "ONLINE",
            status: "PENDING",
            paymentStatus: "PENDING",
            checkoutClosedAt: null,
            acceptedPaymentId: null,
            paymentReviewStatus: "CLEAR",
          },
        })),
        updateMany: vi.fn(async ({ data }: {
          data: {
            lastReconcileAt: Date;
            nextReconcileAt: Date;
          };
        }) => {
          lastReconcileAt = data.lastReconcileAt;
          nextReconcileAt = data.nextReconcileAt;
          attempts++;
          return { count: 1 };
        }),
      },
    };

    const providerResponse = new TextEncoder().encode(
      '{"ok":true,"data":{"token":"test_tracker"}}'
    );

    const provider = {
      fetchTracker: vi.fn()
        .mockResolvedValueOnce({
          kind: "failed",
          code: "PROVIDER_TIMEOUT",
        })
        .mockResolvedValueOnce({
          kind: "fetched",
          bodyBytes: providerResponse,
        }),
    };

    const reconciliation = {
      observe: vi.fn().mockResolvedValue({
        kind: "settled",
      }),
    };

    const createService = () => createPaymentVerificationService({
      database: database as unknown as Deps["database"],
      config: {
        environment: "sandbox",
        merchantAccountRef: "synthetic-account",
      } as Deps["config"],
      provider: provider as unknown as Deps["provider"],
      reconciliation: reconciliation as unknown as Deps["reconciliation"],
      now: () => new Date(currentTime),
      minIntervalMs: 30_000,
    });

    // First verification: Safepay is unavailable.
    const first = await createService().verifyPaymentNow("test_payment");

    expect(first).toEqual({
      kind: "provider_fetch_failed",
      code: "PROVIDER_TIMEOUT",
    });

    expect(attempts).toBe(1);
    expect(nextReconcileAt).toEqual(new Date(start + 60_000));
    expect(reconciliation.observe).not.toHaveBeenCalled();

    // Application/service restarts after 31 seconds.
    // The persisted 60-second retry deadline still applies.
    currentTime = start + 31_000;

    expect(
      await createService().verifyPaymentNow("test_payment")
    ).toEqual({
      kind: "skipped",
      code: "BACKOFF",
    });

    expect(provider.fetchTracker).toHaveBeenCalledTimes(1);

    // After 61 seconds, Safepay becomes available.
    currentTime = start + 61_000;

    expect(
      await createService().verifyPaymentNow("test_payment")
    ).toEqual({
      kind: "settled",
    });

    expect(provider.fetchTracker).toHaveBeenCalledTimes(2);
    expect(reconciliation.observe).toHaveBeenCalledTimes(1);

    const forwarded = reconciliation.observe.mock.calls[0][0];

    expect(forwarded.channel).toBe("RECONCILIATION");
    expect(forwarded.body).toEqual(providerResponse);
  });
});
