import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  vaultKeys: vi.fn(),
  vault: vi.fn(),
  inbox: vi.fn(),
  reconciliation: vi.fn(),
  verification: vi.fn(),
  provider: vi.fn(),
  reservations: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  fetchTracker: vi.fn(),
  observe: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/safepay/config", () => ({
  loadSafepayApiOnlyConfig: mocks.config,
  SafepayConfigurationError: class extends Error {},
}));

vi.mock("@/lib/safepay/provider", () => ({
  createSafepayProvider: mocks.provider,
}));

vi.mock("@/lib/payments/vault-env", () => ({
  loadPaymentPayloadVaultKeys: mocks.vaultKeys,
}));

vi.mock("@/lib/payments/payload-vault", () => ({
  createPaymentPayloadVault: mocks.vault,
}));

vi.mock("@/services/payment-webhook.service", () => ({
  createPaymentWebhookService: mocks.inbox,
}));

vi.mock("@/services/payment-reconciliation.service", () => ({
  createPaymentReconciliationService: mocks.reconciliation,
}));

vi.mock("@/services/payment-verification.service", () => ({
  createPaymentVerificationService: mocks.verification,
}));

vi.mock("@/services/safepay-reservations.service", () => ({
  createSafepayReservationService: mocks.reservations,
}));

import { createPaymentMaintenanceRunner } from
  "@/services/payment-maintenance.service";

describe("Closed-order Safepay investigation", () => {
  const providerBytes = new TextEncoder().encode(
    '{"ok":true,"data":{"state":"TRACKER_ENDED"}}'
  );

  beforeEach(() => {
    vi.resetAllMocks();

    mocks.config.mockReturnValue({
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
    });

    mocks.vaultKeys.mockReturnValue({
      activeKeyId: "test",
      keyRing: new Map(),
    });

    mocks.vault.mockReturnValue({});
    mocks.inbox.mockReturnValue({});

    mocks.reconciliation.mockReturnValue({
      observe: mocks.observe,
    });

    mocks.provider.mockReturnValue({
      fetchTracker: mocks.fetchTracker,
    });

    mocks.findFirst.mockResolvedValue({
      trackerToken: "database_tracker_123",
      providerEnvironment: "sandbox",
      merchantAccountRef: "synthetic-account",
    });

    mocks.findMany.mockResolvedValue([
      {
        attemptNumber: 1,
        provider: "SAFEPAY",
        status: "PENDING",
        reconcileStatus: "REVIEW_REQUIRED",
        trackerToken: "database_tracker_123",
        providerEnvironment: "sandbox",
        merchantAccountRef: "synthetic-account",
        creationStartedAt: new Date(),
        attemptState: "TRACKER_CREATED",
        reference: "synthetic_reference",
        retryRequestKey: null,
      },
    ]);
    mocks.fetchTracker.mockResolvedValue({
      kind: "fetched",
      bodyBytes: providerBytes,
    });

    mocks.observe.mockResolvedValue({
      kind: "review_required",
    });
  });

  function runner() {
    const database = {
      payment: {
        findFirst: mocks.findFirst,
        findMany: mocks.findMany,
      },
    };

    return createPaymentMaintenanceRunner(database as never);
  }

  it("investigates using only the database-bound tracker", async () => {
    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      action: "investigate_closed_order_payment",
      orderId: "order_123",
      outcome: "review_required",
    });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: "order_123",
          order: expect.objectContaining({
            status: "CANCELLED",
            paymentStatus: "PENDING",
            paymentReviewStatus: "REQUIRED",
            checkoutClosedAt: { not: null },
          }),
        }),
        take: 11,
      })
    );
    expect(mocks.fetchTracker).toHaveBeenCalledWith({
      trackerToken: "database_tracker_123",
    });

    expect(mocks.observe).toHaveBeenCalledWith({
      provider: "SAFEPAY",
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
      channel: "RECONCILIATION",
      body: providerBytes,
      headers: {},
    });
  });

  it("rejects invalid order identifiers", async () => {
    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "invalid order id!" }
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      code: "ORDER_NOT_FOUND",
    });

    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.fetchTracker).not.toHaveBeenCalled();
  });

  it("skips orders without an eligible payment", async () => {
    mocks.findMany.mockResolvedValue([]);

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "skipped",
      code: "NOT_ELIGIBLE",
    });

    expect(mocks.fetchTracker).not.toHaveBeenCalled();
  });

  it("blocks foreign merchant payment attempts", async () => {
    mocks.findMany.mockResolvedValue([{
      attemptNumber: 1,
      provider: "SAFEPAY",
      status: "PENDING",
      reconcileStatus: "REVIEW_REQUIRED",
      trackerToken: "database_tracker_123",
      providerEnvironment: "sandbox",
      merchantAccountRef: "foreign-account",
      creationStartedAt: new Date(),
      attemptState: "TRACKER_CREATED",
      reference: "synthetic_reference",
      retryRequestKey: null,
    }]);
    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "incomplete_review",
      attempts: [{
        attemptNumber: 1,
        outcome: "blocked",
        code: "PROVIDER_BINDING_MISMATCH",
      }],
    });
    expect(mocks.fetchTracker).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });

  it("does not process evidence when Safepay is unavailable", async () => {
    mocks.findMany.mockResolvedValue([
      {
        attemptNumber: 1,
        provider: "SAFEPAY",
        status: "PENDING",
        reconcileStatus: "REVIEW_REQUIRED",
        trackerToken: "database_tracker_123",
        providerEnvironment: "sandbox",
        merchantAccountRef: "synthetic-account",
        creationStartedAt: new Date(),
        attemptState: "TRACKER_CREATED",
        reference: "synthetic_reference",
        retryRequestKey: null,
      },
    ]);
    mocks.fetchTracker.mockResolvedValue({
      kind: "failed",
      code: "PROVIDER_TIMEOUT",
    });

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "provider_fetch_failed",
      code: "PROVIDER_TIMEOUT",
    });

    expect(mocks.observe).not.toHaveBeenCalled();
  });
  function makeAttempt(number: number, tracker: string | null) {
    return {
      attemptNumber: number,
      provider: "SAFEPAY",
      status: "PENDING",
      reconcileStatus: "REVIEW_REQUIRED",
      trackerToken: tracker,
      providerEnvironment: "sandbox",
      merchantAccountRef: "synthetic-account",
      creationStartedAt: new Date(),
      attemptState: "TRACKER_CREATED",
      reference: `reference_${number}`,
      retryRequestKey: null,
    };
  }

  it("investigates two payment attempts without skipping either", async () => {
    mocks.findMany.mockResolvedValue([
      makeAttempt(1, "tracker_1"),
      makeAttempt(2, "tracker_2"),
    ]);

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(mocks.fetchTracker).toHaveBeenCalledTimes(2);

    expect(mocks.fetchTracker).toHaveBeenNthCalledWith(
      1, { trackerToken: "tracker_1" }
    );

    expect(mocks.fetchTracker).toHaveBeenNthCalledWith(
      2, { trackerToken: "tracker_2" }
    );

    expect(mocks.observe).toHaveBeenCalledTimes(2);

    expect(result).toMatchObject({
      outcome: "review_required",
      attempts: [
        { attemptNumber: 1, outcome: "review_required" },
        { attemptNumber: 2, outcome: "review_required" },
      ],
    });
  });

  it("reports incomplete review when one attempt has no tracker", async () => {
    mocks.findMany.mockResolvedValue([
      makeAttempt(1, "tracker_1"),
      makeAttempt(2, null),
    ]);

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "incomplete_review",
      attempts: [
        { attemptNumber: 1, outcome: "review_required" },
        {
          attemptNumber: 2,
          outcome: "blocked",
          code: "MISSING_TRACKER_REQUIRES_REVIEW",
        },
      ],
    });

    expect(mocks.fetchTracker).toHaveBeenCalledTimes(1);
    expect(mocks.observe).toHaveBeenCalledTimes(1);
  });

  it("continues investigating other attempts after provider timeout", async () => {
    mocks.findMany.mockResolvedValue([
      makeAttempt(1, "tracker_1"),
      makeAttempt(2, "tracker_2"),
    ]);

    mocks.fetchTracker.mockResolvedValueOnce({
      kind: "failed",
      code: "PROVIDER_TIMEOUT",
    });

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "incomplete_review",
      attempts: [
        {
          attemptNumber: 1,
          outcome: "provider_fetch_failed",
          code: "PROVIDER_TIMEOUT",
        },
        {
          attemptNumber: 2,
          outcome: "review_required",
        },
      ],
    });

    expect(mocks.fetchTracker).toHaveBeenCalledTimes(2);
    expect(mocks.observe).toHaveBeenCalledTimes(1);
  });

  it("refuses partial investigation when more than ten attempts exist", async () => {
    mocks.findMany.mockResolvedValue(
      Array.from(
        { length: 11 },
        (_, index) => makeAttempt(index + 1, `tracker_${index + 1}`)
      )
    );

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "blocked",
      code: "TOO_MANY_ATTEMPTS",
    });

    expect(mocks.fetchTracker).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });
  function readyAttempt() {
    return {
      ...makeAttempt(1, null),
      attemptState: "READY",
      creationStartedAt: null,
      reference: null,
      retryRequestKey: null,
      capturedAmountMinor: BigInt(0),
      refundedAmountMinor: BigInt(0),
      paidVerifiedAt: null,
    };
  }

  it("recognizes only a clean READY attempt as locally unstarted", async () => {
    mocks.findMany.mockResolvedValue([readyAttempt()]);

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "review_required",
      attempts: [
        { attemptNumber: 1, outcome: "not_started" },
      ],
    });

    expect(mocks.fetchTracker).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });

  it("rejects a READY attempt with an inconsistent PAID status", async () => {
    mocks.findMany.mockResolvedValue([{
      ...readyAttempt(),
      status: "PAID",
    }]);

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "incomplete_review",
      attempts: [{
        outcome: "blocked",
        code: "UNEXPECTED_PAYMENT_STATE",
      }],
    });

    expect(mocks.fetchTracker).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "captured amount",
      changes: { capturedAmountMinor: BigInt(100) },
    },
    {
      label: "refunded amount",
      changes: { refundedAmountMinor: BigInt(100) },
    },
    {
      label: "verified payment timestamp",
      changes: { paidVerifiedAt: new Date("2026-11-12T12:00:00Z") },
    },
  ])("does not mislabel READY with $label as unstarted", async ({ changes }) => {
    mocks.findMany.mockResolvedValue([{
      ...readyAttempt(),
      ...changes,
    }]);

    const result = await runner().run(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(result).toMatchObject({
      outcome: "incomplete_review",
      attempts: [{
        outcome: "blocked",
        code: "FINANCIAL_ACTIVITY_REQUIRES_REVIEW",
      }],
    });

    expect(mocks.fetchTracker).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });
});





