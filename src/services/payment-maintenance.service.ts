import "server-only";
import { db } from "@/lib/db";
import { capturePaymentAlert } from "@/lib/error-monitoring";
import { loadSafepayApiOnlyConfig, SafepayConfigurationError, type SafepayConfig } from "@/lib/safepay/config";
import { createSafepayProvider } from "@/lib/safepay/provider";
import { createSafepayReservationService, type ExpiryProviderCheck } from "@/services/safepay-reservations.service";
import { createPaymentWebhookService, type PaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentVerificationService, type PaymentVerificationService, type PaymentDatabase } from "@/services/payment-verification.service";
import { createPaymentRefundService } from "@/services/payment-refund.service";
import { cleanupEmailOutboxEntries } from "@/services/email-outbox.service";
import { pruneStaleGuestCarts } from "@/services/cart.service";
import { createPaymentPayloadVault, type PaymentPayloadVault } from "@/lib/payments/payload-vault";
import { loadPaymentPayloadVaultKeys } from "@/lib/payments/vault-env";
import { localId } from "@/lib/safepay/contracts";
import { SAFEPAY_REFUNDS_SANDBOX_ONLY } from "@/lib/safepay/readiness";

// Shared maintenance runner for Khareedo's managed Safepay payments. Both callers
// execute the exact same bounded, idempotent actions:
//   1. POST /api/admin/payments/maintenance (admin session; optional shared token)
//   2. the in-process background worker started from instrumentation.ts (no HTTP)
// Keeping one implementation prevents the two entry points from drifting. Every action
// is a bounded sweep or a single targeted verification; nothing here invents provider
// finality â€” settlement always flows through the authenticated-evidence pipeline.

export const MAINTENANCE_ACTIONS = [
  "expire_reservations",
  "verify_expiring_payments",
  "process_webhook_inbox",
  "reconcile_due_payments",
  "verify_order_payment",
  "investigate_closed_order_payment",
  "reconcile_refunds",
  "cleanup_email_outbox",
  "prune_stale_carts",
] as const;
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

export type MaintenanceActionUnavailable = "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE" |
  "SAFEPAY_CONFIGURATION_UNAVAILABLE" | "REFUNDS_SANDBOX_ONLY";

export type PaymentMaintenanceRunResult =
  | { action: "expire_reservations"; batch: number; released: number; reviewRequired: number; settled: number; failed: number }
  | { action: "verify_expiring_payments"; batch: number; considered: number; outcomes: Array<{ paymentId: string; outcome: string; code?: string }> }
  | { action: "process_webhook_inbox"; batch: number; considered: number; outcomes: Array<{ eventId: string; result: string }> }
  | { action: "reconcile_due_payments"; batch: number; considered: number; outcomes: Array<{ paymentId: string; outcome: string; code?: string }> }
  | { action: "verify_order_payment"; orderId: string; outcome: string; code?: string }
  | { action: "investigate_closed_order_payment"; orderId: string; outcome: string; code?: string; attempts?: Array<{ attemptNumber: number | null; outcome: string; code?: string }> }
  | { action: "reconcile_refunds"; batch: number; considered: number; released: number; outcomes: Array<{ refundId: string; disposition: string; outcome?: string; code?: string }> }
  | { action: "cleanup_email_outbox"; batch: number; deleted: number }
  | { action: "prune_stale_carts"; batch: number; deleted: number }
  | { action: MaintenanceAction; blocked: true; code: MaintenanceActionUnavailable };
export type MaintenanceRunResult = PaymentMaintenanceRunResult;

type PaymentStack = {
  inbox: PaymentWebhookService;
  reconciliation: ReturnType<typeof createPaymentReconciliationService>;
  verification: (config: SafepayConfig) => PaymentVerificationService;
};

function createPaymentStack(database: PaymentDatabase): PaymentStack | null {
  const vaultKeys = loadPaymentPayloadVaultKeys();
  if (!vaultKeys) return null; // Encrypted custody is mandatory before any evidence is stored.
  const vault: PaymentPayloadVault = createPaymentPayloadVault(vaultKeys.activeKeyId, vaultKeys.keyRing);
  const inbox = createPaymentWebhookService(database as never, vault, { reconcileDelayMs: 60_000 });
  const reconciliation = createPaymentReconciliationService(database as never, inbox);
  return {
    inbox,
    reconciliation,
    verification: (config: SafepayConfig) =>
      createPaymentVerificationService({
        database, config,
        provider: createSafepayProvider(config),
        reconciliation,
      }),
  };
}

// --- Payment failure alerts ------------------------------------------------
// Pure alert decisions, exported so they are unit-testable (same precedent as
// the health endpoint's evaluateHealthStatus). Each helper emits at most one
// throttled alert per sweep for the first failing item; the underlying
// error-monitoring throttle also bounds repeat alerts across sweeps.

export function alertOnBlockedInboxOutcomes(
  outcomes: Array<{ eventId: string; result: string }>,
): void {
  const blocked = outcomes.filter((o) => o.result === "blocked");
  if (blocked.length === 0) return;
  capturePaymentAlert("WEBHOOK_FAILURE", {
    operation: "process-webhook-inbox",
    code: "INBOX_PROCESSING_BLOCKED",
    count: blocked.length,
    eventId: blocked[0].eventId,
  });
}

export function alertOnRefundReconciliationOutcomes(
  outcomes: Array<{ refundId: string; disposition: string; outcome?: string; code?: string }>,
): void {
  const failedSubmissions = outcomes.filter(
    (o) => o.disposition === "submitted" && o.outcome === "failed",
  );
  if (failedSubmissions.length > 0) {
    capturePaymentAlert("PAYMENT_FAILURE", {
      operation: "reconcile-refunds",
      code: failedSubmissions[0].code ?? "REFUND_SUBMISSION_FAILED",
      count: failedSubmissions.length,
    });
  }
  const providerFetchFailed = outcomes.filter(
    (o) => o.disposition === "provider_fetch_failed",
  );
  if (providerFetchFailed.length > 0) {
    capturePaymentAlert("RECONCILIATION_FAILURE", {
      operation: "reconcile-refunds",
      code: providerFetchFailed[0].code ?? "PROVIDER_FETCH_FAILED",
      count: providerFetchFailed.length,
    });
  }
}

export function alertOnProviderFetchFailures(
  outcomes: Array<{ paymentId?: string; orderId?: string; outcome: string; code?: string }>,
  operation: "reconcile-due-payments" | "verify-order-payment" | "verify-expiring-payments",
): void {
  const fetchFailed = outcomes.filter((o) => o.outcome === "provider_fetch_failed");
  if (fetchFailed.length === 0) return;
  capturePaymentAlert("RECONCILIATION_FAILURE", {
    operation,
    code: fetchFailed[0].code ?? "PROVIDER_FETCH_FAILED",
    count: fetchFailed.length,
    ...(fetchFailed[0].paymentId ? { paymentId: fetchFailed[0].paymentId } : {}),
    ...(fetchFailed[0].orderId ? { orderId: fetchFailed[0].orderId } : {}),
  });
}

export function createPaymentMaintenanceRunner(injectedDatabase?: PaymentDatabase) {
  const database = injectedDatabase ?? (db as unknown as PaymentDatabase);

  return {
    async run(action: MaintenanceAction, batch: number, target?: { orderId?: string }): Promise<PaymentMaintenanceRunResult> {
      if (action === "expire_reservations") {
        // M-26: consult the provider before closing a possibly-paid tracker.
        // Best-effort here — without Safepay config or payload custody there
        // is no verifier, and expiry proceeds as before (the close retains
        // holds for review and the investigate action consults the provider
        // later). Only a missing-config error is swallowed; anything else
        // throws, as in the provider branches below.
        let verify: ExpiryProviderCheck | undefined;
        try {
          const expireConfig = loadSafepayApiOnlyConfig();
          const expireStack = createPaymentStack(database);
          if (expireStack) {
            const verification = expireStack.verification(expireConfig);
            verify = (paymentId: string) => verification.verifyPaymentNow(paymentId);
          }
        } catch (error) {
          if (!(error instanceof SafepayConfigurationError)) throw error;
        }
        const reservations = createSafepayReservationService(database as never, undefined, { verifyPayment: verify });
        const results = await reservations.expireBatch(batch);
        return { action, batch,
          released: results.filter(r => r.result.ok && r.result.outcome === "RELEASED").length,
          reviewRequired: results.filter(r => r.result.ok && r.result.outcome === "REVIEW_REQUIRED").length,
          settled: results.filter(r => r.result.ok && r.result.outcome === "SETTLED").length,
          failed: results.filter(r => !r.result.ok).length };
      }

      // Email outbox retention (Phase 3 Chunk 7, M-23). Deliberately placed
      // before the Safepay config gate below: deleting old terminal outbox
      // rows needs no provider credentials or payload custody, exactly like
      // reservation expiry. The batch size is irrelevant here (one bounded
      // deleteMany over the 30-day cutoff) and is echoed back unchanged.
      if (action === "cleanup_email_outbox") {
        const { deleted } = await cleanupEmailOutboxEntries();
        return { action, batch, deleted };
      }

      // Stale guest-cart pruning (Phase 3, chunk 12 follow-up B). Same
      // placement as the outbox cleanup: no provider credentials or
      // payload custody needed, one bounded deleteMany over the 30-day
      // cutoff (the guest-cart cookie lifetime). Batch is echoed back
      // unchanged.
      if (action === "prune_stale_carts") {
        const { deleted } = await pruneStaleGuestCarts();
        return { action, batch, deleted };
      }

      // Provider-independent actions still need encrypted payload custody (inbox) or
      // server Safepay credentials (reporter lookups); report their absence instead of throwing.
      if (action === "process_webhook_inbox") {
        const stack = createPaymentStack(database);
        if (!stack) return { action, blocked: true, code: "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE" };
        const events = await stack.inbox.pending(batch);
        const outcomes: Array<{ eventId: string; result: string }> = [];
        for (const event of events) {
          const processed = await stack.inbox.process(event.id);
          outcomes.push({ eventId: event.id, result: processed.kind });
        }
        alertOnBlockedInboxOutcomes(outcomes);
        return { action, batch, considered: events.length, outcomes };
      }

      let config;
      try {
        // API-only config: background sweeps never build customer-facing URLs.
        config = loadSafepayApiOnlyConfig();
      } catch (error) {
        if (!(error instanceof SafepayConfigurationError)) throw error;
        return { action, blocked: true, code: "SAFEPAY_CONFIGURATION_UNAVAILABLE" };
      }
      if (action === "reconcile_refunds" && SAFEPAY_REFUNDS_SANDBOX_ONLY && config.environment !== "sandbox") {
        return { action, blocked: true, code: "REFUNDS_SANDBOX_ONLY" };
      }
      const stack = createPaymentStack(database);
      if (!stack) return { action, blocked: true, code: "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE" };

      if (action === "reconcile_refunds") {
        const provider = createSafepayProvider(config);
        const refunds = createPaymentRefundService(database as never, provider, {
          environment: config.environment,
          merchantAccountRef: config.merchantAccountRef,
          pollDelayMs: 60_000,
          maxConfirmationAttempts: 6,
          submitGraceMs: 120_000,
          reversalWindowMs: 24 * 3_600_000,
          cardRefundWindowMs: 90 * 24 * 3_600_000,
        });
        const result = await stack.reconciliation.reconcileDueRefunds(refunds, provider, {
          environment: config.environment,
          merchantAccountRef: config.merchantAccountRef,
        }, batch);
        alertOnRefundReconciliationOutcomes(result.outcomes);
        return { action, batch, ...result };
      }

      // Admin-only investigation of a financially uncertain CLOSED order.
      // Never reopens the order, directly settles funds, or releases holds.
      if (action === "investigate_closed_order_payment") {
        const orderId = target?.orderId ?? "";

        if (!localId.safeParse(orderId).success) {
          return {
            action, orderId: "",
            outcome: "blocked",
            code: "ORDER_NOT_FOUND",
          };
        }

        // Inspect ALL attempts. Never mistake one successful lookup
        // for financial finality of the entire closed order.
        const attempts = await database.payment.findMany({
          where: {
            orderId,
            order: {
              paymentFlowVersion: 1,
              paymentMethod: "ONLINE",
              status: "CANCELLED",
              paymentStatus: "PENDING",
              checkoutClosedAt: { not: null },
              acceptedPaymentId: null,
              paymentReviewStatus: "REQUIRED",
            },
          },
          orderBy: [{ attemptNumber: "asc" }, { id: "asc" }],
          take: 11,
          select: {
            attemptNumber: true,
            provider: true,
            status: true,
            reconcileStatus: true,
            trackerToken: true,
            providerEnvironment: true,
            merchantAccountRef: true,
            creationStartedAt: true,
            attemptState: true,
            reference: true,
            retryRequestKey: true,
            capturedAmountMinor: true,
            refundedAmountMinor: true,
            paidVerifiedAt: true,
          },
        });

        if (attempts.length === 0) {
          return {
            action, orderId,
            outcome: "skipped",
            code: "NOT_ELIGIBLE",
          };
        }
        // Refuse partial investigation when the attempt count
        // exceeds the bounded limit.
        if (attempts.length > 10) {
          return {
            action, orderId,
            outcome: "blocked",
            code: "TOO_MANY_ATTEMPTS",
          };
        }

        const outcomes: Array<{
          attemptNumber: number | null;
          outcome: string;
          code?: string;
        }> = [];

        let incomplete = false;
        const provider = createSafepayProvider(config);

        for (const attempt of attempts) {
          const number = attempt.attemptNumber;

          const flag = (code: string) => {
            incomplete = true;
            outcomes.push({
              attemptNumber: number,
              outcome: "blocked",
              code,
            });
          };

          if (
            attempt.provider !== "SAFEPAY" ||
            attempt.providerEnvironment !== config.environment ||
            attempt.merchantAccountRef !== config.merchantAccountRef
          ) {
            flag("PROVIDER_BINDING_MISMATCH");
            continue;
          }

          if (number === null) {
            flag("ATTEMPT_IDENTITY_UNAVAILABLE");
            continue;
          }

          // Never classify an inconsistent financial state
          // as an attempt that has not started.
          if (
            attempt.status !== "PENDING" ||
            attempt.reconcileStatus !== "REVIEW_REQUIRED"
          ) {
            flag("UNEXPECTED_PAYMENT_STATE");
            continue;
          }

          if (
            (attempt.capturedAmountMinor ?? BigInt(0)) !== BigInt(0) ||
            (attempt.refundedAmountMinor ?? BigInt(0)) !== BigInt(0) ||
            attempt.paidVerifiedAt != null
          ) {
            flag("FINANCIAL_ACTIVITY_REQUIRES_REVIEW");
            continue;
          }

          // Only a clean, locally unstarted READY attempt
          // may be labelled not_started.
          if (
            !attempt.trackerToken &&
            !attempt.creationStartedAt &&
            !attempt.reference &&
            !attempt.retryRequestKey &&
            attempt.attemptState === "READY"
          ) {
            outcomes.push({
              attemptNumber: number,
              outcome: "not_started",
            });
            continue;
          }

          if (!attempt.trackerToken) {
            flag("MISSING_TRACKER_REQUIRES_REVIEW");
            continue;
          }

          try {
            const fetched = await provider.fetchTracker({
              trackerToken: attempt.trackerToken,
            });

            if (fetched.kind !== "fetched") {
              incomplete = true;
              outcomes.push({
                attemptNumber: number,
                outcome: "provider_fetch_failed",
                code: fetched.code,
              });
              continue;
            }

            // Existing authenticated evidence pipeline.
            // Closed orders remain blocked from settlement.
            const result = await stack.reconciliation.observe({
              provider: "SAFEPAY",
              environment: config.environment,
              merchantAccountRef: config.merchantAccountRef,
              channel: "RECONCILIATION",
              body: fetched.bodyBytes,
              headers: {},
            });

            outcomes.push({
              attemptNumber: number,
              outcome: result.kind,
              ...("code" in result ? { code: result.code } : {}),
            });

            if (
              !["review_required", "recorded", "duplicate"].includes(
                result.kind
              )
            ) {
              incomplete = true;
            }
          } catch {
            incomplete = true;
            outcomes.push({
              attemptNumber: number,
              outcome: "blocked",
              code: "INVESTIGATION_UNAVAILABLE",
            });
          }
        }

        // Preserve the existing single-attempt timeout response.
        const singleFailure =
          outcomes.length === 1 &&
          outcomes[0].outcome === "provider_fetch_failed";

        return {
          action,
          orderId,
          outcome: incomplete
            ? singleFailure
              ? "provider_fetch_failed"
              : "incomplete_review"
            : "review_required",
          ...(singleFailure ? { code: outcomes[0].code } : {}),
          attempts: outcomes,
        };
      }

      if (action === "verify_order_payment") {
        const orderId = target?.orderId ?? "";
        if (!localId.safeParse(orderId).success) return { action, orderId: "", outcome: "blocked", code: "ORDER_NOT_FOUND" };
        const payment = await database.payment.findFirst({
          where: { orderId, provider: "SAFEPAY", attemptNumber: { not: null } },
          orderBy: { attemptNumber: "desc" },
          select: { id: true },
        });
        if (!payment) return { action, orderId, outcome: "skipped", code: "ORDER_NOT_FOUND" };
        const outcome = await stack.verification(config).verifyPaymentNow(payment.id);
        alertOnProviderFetchFailures(
          [{ paymentId: payment.id, orderId, outcome: outcome.kind, ...("code" in outcome ? { code: outcome.code } : {}) }],
          "verify-order-payment",
        );
        return { action, orderId, outcome: outcome.kind, ...("code" in outcome ? { code: outcome.code } : {}) };
      }

      // Pre-expiry provider check (M-26): force-verify payments whose
      // reservations expire within the next five minutes, while settlement
      // is still possible. The worker runs this before expire_reservations
      // in the same sweep (see SWEEP_PLAN), so a capture is settled rather
      // than LATE_CAPTURE-reviewed. The force flag bypasses the
      // transport-failure backoff only — an in-flight fetch is never
      // doubled — and the batch bounds the provider calls per sweep.
      if (action === "verify_expiring_payments") {
        const verification = stack.verification(config);
        const due = await stack.reconciliation.dueForPreExpiryCheck(batch);
        const outcomes: Array<{ paymentId: string; outcome: string; code?: string }> = [];
        for (const payment of due) {
          if (payment.provider !== "SAFEPAY" || !payment.trackerToken) continue;
          const outcome = await verification.verifyPaymentNow(payment.id, { force: true });
          outcomes.push({ paymentId: payment.id, outcome: outcome.kind, ...("code" in outcome ? { code: outcome.code } : {}) });
        }
        alertOnProviderFetchFailures(outcomes, "verify-expiring-payments");
        return { action, batch, considered: due.length, outcomes };
      }

      // reconcile_due_payments: bounded sweep of due managed attempts through the same
      // targeted verification path (reporter fetch, transport-failure backoff, observe).
      const due = await stack.reconciliation.due(batch);
      const outcomes: Array<{ paymentId: string; outcome: string; code?: string }> = [];
      for (const payment of due) {
        if (payment.provider !== "SAFEPAY" || !payment.trackerToken) continue;
        const outcome = await stack.verification(config).verifyPaymentNow(payment.id);
        outcomes.push({ paymentId: payment.id, outcome: outcome.kind, ...("code" in outcome ? { code: outcome.code } : {}) });
      }
      alertOnProviderFetchFailures(outcomes, "reconcile-due-payments");
      return { action, batch, considered: due.length, outcomes };
    },
  };
}




