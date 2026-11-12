import "server-only";
import { db } from "@/lib/db";
import { loadSafepayApiOnlyConfig, SafepayConfigurationError, type SafepayConfig } from "@/lib/safepay/config";
import { createSafepayProvider } from "@/lib/safepay/provider";
import { createSafepayReservationService } from "@/services/safepay-reservations.service";
import { createPaymentWebhookService, type PaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentVerificationService, type PaymentVerificationService, type PaymentDatabase } from "@/services/payment-verification.service";
import { createPaymentPayloadVault, type PaymentPayloadVault } from "@/lib/payments/payload-vault";
import { loadPaymentPayloadVaultKeys } from "@/lib/payments/vault-env";
import { localId } from "@/lib/safepay/contracts";

// Shared maintenance runner for Khareedo's managed Safepay payments. Both callers
// execute the exact same bounded, idempotent actions:
//   1. POST /api/admin/payments/maintenance (admin session; optional shared token)
//   2. the in-process background worker started from instrumentation.ts (no HTTP)
// Keeping one implementation prevents the two entry points from drifting. Every action
// is a bounded sweep or a single targeted verification; nothing here invents provider
// finality â€” settlement always flows through the authenticated-evidence pipeline.

export const MAINTENANCE_ACTIONS = [
  "expire_reservations",
  "process_webhook_inbox",
  "reconcile_due_payments",
  "verify_order_payment",
  "investigate_closed_order_payment",
] as const;
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

export type MaintenanceActionUnavailable = "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE" | "SAFEPAY_CONFIGURATION_UNAVAILABLE";

export type MaintenanceRunResult =
  | { action: "expire_reservations"; batch: number; released: number; reviewRequired: number; failed: number }
  | { action: "process_webhook_inbox"; batch: number; considered: number; outcomes: Array<{ eventId: string; result: string }> }
  | { action: "reconcile_due_payments"; batch: number; considered: number; outcomes: Array<{ paymentId: string; outcome: string; code?: string }> }
  | { action: "verify_order_payment"; orderId: string; outcome: string; code?: string }
  | { action: "investigate_closed_order_payment"; orderId: string; outcome: string; code?: string; attempts?: Array<{ attemptNumber: number | null; outcome: string; code?: string }> }
  | { action: MaintenanceAction; blocked: true; code: MaintenanceActionUnavailable };

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

export function createPaymentMaintenanceRunner(injectedDatabase?: PaymentDatabase) {
  const database = injectedDatabase ?? (db as unknown as PaymentDatabase);

  return {
    async run(action: MaintenanceAction, batch: number, target?: { orderId?: string }): Promise<MaintenanceRunResult> {
      if (action === "expire_reservations") {
        const reservations = createSafepayReservationService(database as never);
        const results = await reservations.expireBatch(batch);
        return { action, batch,
          released: results.filter(r => r.result.ok && r.result.outcome === "RELEASED").length,
          reviewRequired: results.filter(r => r.result.ok && r.result.outcome === "REVIEW_REQUIRED").length,
          failed: results.filter(r => !r.result.ok).length };
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
      const stack = createPaymentStack(database);
      if (!stack) return { action, blocked: true, code: "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE" };

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
        return { action, orderId, outcome: outcome.kind, ...("code" in outcome ? { code: outcome.code } : {}) };
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
      return { action, batch, considered: due.length, outcomes };
    },
  };
}

export type PaymentMaintenanceRunner = ReturnType<typeof createPaymentMaintenanceRunner>;





