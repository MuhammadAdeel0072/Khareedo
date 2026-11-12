import "server-only";
import type { PrismaClient } from "../../generated/postgres-client";
import type { SafepayConfig } from "@/lib/safepay/config";
import type { SafepayProvider } from "@/lib/safepay/provider";
import type { createPaymentReconciliationService } from "./payment-reconciliation.service";

// Targeted, single-payment server-side verification through the documented reporter
// endpoint (GET /reporter/api/v1/payments/{tracker} with X-SFPY-MERCHANT-SECRET).
//
// Why this exists: settlement requires authenticated provider evidence. That evidence
// previously had exactly two entry points — a Safepay webhook (impossible on origins
// Safepay cannot reach, e.g. localhost/preview) and the admin maintenance sweep (never
// scheduled). A customer who paid successfully and returned to the store therefore
// stayed PENDING forever. This service adds the missing targeted path: it is triggered
// ONLY for a payment already resolved and owner-validated by an internal caller
// (return page, admin maintenance, scheduled sweep) and it never trusts browser input —
// the tracker token always comes from the database row bound at checkout time.
//
// Money never moves here. A successful fetch feeds the exact response bytes into the
// existing reconciliation → inbox → settlement pipeline, which re-validates identity,
// amounts, currency, environment and reservation integrity inside its own serializable
// transaction. A transport failure only schedules a retry — it never guesses finality.

export type PaymentDatabase = Pick<PrismaClient, "$transaction" | "payment">;

export type PaymentVerificationOutcome =
  | { kind: "settled" | "already_settled" | "recorded" | "review_required" | "duplicate" }
  | { kind: "stored" | "quarantined" | "conflict"; eventId: string }
  | { kind: "blocked"; code: string }
  | { kind: "provider_fetch_failed"; code: string }
  | { kind: "skipped"; code: "NOT_ELIGIBLE" | "BACKOFF" };

export type ReconciliationObserver = ReturnType<typeof createPaymentReconciliationService>;

const MAX_LAST_ERROR_CODE_LENGTH = 64;
const FETCH_RETRY_BASE_MS = 60_000;
const FETCH_RETRY_MAX_MS = 900_000;

/** Exponential, capped retry scheduling for transport failures only. Financial state is untouched. */
export function fetchRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 16) - 1);
  return Math.min(FETCH_RETRY_BASE_MS * 2 ** exponent, FETCH_RETRY_MAX_MS);
}

export function createPaymentVerificationService(deps: {
  database: PaymentDatabase;
  config: SafepayConfig;
  provider: Pick<SafepayProvider, "fetchTracker">;
  reconciliation: ReconciliationObserver;
  now?: () => Date;
  /** Minimum spacing between provider lookups for one payment (refresh-spam guard). */
  minIntervalMs?: number;
}) {
  const now = deps.now ?? (() => new Date());
  const minIntervalMs = deps.minIntervalMs ?? 30_000;

  async function recordFetchFailure(paymentId: string, code: string, attempts: number): Promise<void> {
    const at = now();
    // Scheduling fields only. Deliberately no version CAS: concurrent settlement retries
    // converge on the same retry schedule, and a bumped version only makes a concurrent
    // settlement retry (its CAS fails → re-read), never weakens a check.
    await deps.database.payment.updateMany({
      where: { id: paymentId, status: "PENDING", reconcileStatus: { in: ["PENDING", "UNCERTAIN"] } },
      data: {
        reconcileAttempts: { increment: 1 },
        lastErrorCode: code.slice(0, MAX_LAST_ERROR_CODE_LENGTH),
        lastErrorAt: at,
        lastReconcileAt: at,
        nextReconcileAt: new Date(at.getTime() + fetchRetryDelayMs(attempts)),
        version: { increment: 1 },
      },
    });
  }

  return {
    /**
     * One server-initiated verification attempt for ONE payment. The caller must have
     * resolved the payment id from a trusted, owner-validated context — never from a
     * browser-supplied identifier alone.
     */
    async verifyPaymentNow(paymentId: string): Promise<PaymentVerificationOutcome> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(paymentId)) return { kind: "skipped", code: "NOT_ELIGIBLE" };
      const at = now();
      const payment = await deps.database.payment.findFirst({
        where: {
          id: paymentId,
          provider: "SAFEPAY",
          providerEnvironment: deps.config.environment,
          merchantAccountRef: deps.config.merchantAccountRef,
          status: "PENDING",
          attemptNumber: { not: null },
          trackerToken: { not: null },
          reconcileStatus: { in: ["PENDING", "UNCERTAIN"] },
        },
        select: {
  id: true,
  trackerToken: true,
  lastReconcileAt: true,
  nextReconcileAt: true,
  reconcileAttempts: true,
          order: {
            select: {
              id: true, paymentFlowVersion: true, paymentMethod: true, status: true,
              paymentStatus: true, checkoutClosedAt: true, acceptedPaymentId: true,
              paymentReviewStatus: true,
            },
          },
        },
      });
      const order = payment?.order;
      if (!payment || !order || !payment.trackerToken ||
          order.paymentFlowVersion !== 1 || order.paymentMethod !== "ONLINE" ||
          order.status !== "PENDING" || order.paymentStatus !== "PENDING" ||
          order.checkoutClosedAt !== null || order.acceptedPaymentId !== null ||
          (order.paymentReviewStatus !== null && order.paymentReviewStatus !== "CLEAR")) {
        return { kind: "skipped", code: "NOT_ELIGIBLE" };
      }
      if (
  payment.nextReconcileAt &&
  at.getTime() < payment.nextReconcileAt.getTime()
) {
  return { kind: "skipped", code: "BACKOFF" };
}

      const fetched = await deps.provider.fetchTracker({ trackerToken: payment.trackerToken });
      if (fetched.kind !== "fetched") {
        await recordFetchFailure(payment.id, fetched.code, payment.reconcileAttempts);
        return { kind: "provider_fetch_failed", code: fetched.code };
      }
      // The exact provider bytes enter the approved reconciliation adapter; settlement
      // re-validates everything inside its own transaction. Nothing is parsed here.
      const observed = await deps.reconciliation.observe({
        provider: "SAFEPAY",
        environment: deps.config.environment,
        merchantAccountRef: deps.config.merchantAccountRef,
        channel: "RECONCILIATION",
        body: fetched.bodyBytes,
        headers: {},
      });
      return observed;
    },
  };
}

export type PaymentVerificationService = ReturnType<typeof createPaymentVerificationService>;
