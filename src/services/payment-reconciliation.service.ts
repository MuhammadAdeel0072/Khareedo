import "server-only";
import type { VerificationInput } from "@/lib/payments/evidence-contract";
import type { PaymentPersistence } from "@/services/payment-settlement.service";
import type { PaymentWebhookService } from "@/services/payment-webhook.service";
import type { PaymentRefundService } from "@/services/payment-refund.service";
import type { SafepayProvider } from "@/lib/safepay/provider";

/** Internal observation processing and bounded work discovery. No provider lookup endpoint is assumed or called. */
export function createPaymentReconciliationService(database: PaymentPersistence, inbox: PaymentWebhookService,
  clock = () => new Date()) {
  return {
    async observe(input: VerificationInput) {
      if (input.channel !== "RECONCILIATION") return { kind: "blocked" as const, code: "INVALID_CHANNEL" as const };
      const received = await inbox.receive(input);
      if (received.kind !== "stored" && received.kind !== "duplicate") return received;
      return inbox.process(received.eventId);
    },
    async due(limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid reconciliation batch size.");
      return database.$transaction(tx => tx.payment.findMany({ where: {
        attemptNumber: { not: null }, trackerToken: { not: null }, status: "PENDING",
        reconcileStatus: { in: ["PENDING", "UNCERTAIN"] }, order: { paymentFlowVersion: 1, paymentMethod: "ONLINE",
          status: "PENDING", paymentStatus: "PENDING", checkoutClosedAt: null, acceptedPaymentId: null, paymentReviewStatus: "CLEAR" },
        OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: clock() } }],
      }, orderBy: [{ nextReconcileAt: "asc" }, { id: "asc" }], take: limit,
      select: { id: true, orderId: true, provider: true, providerEnvironment: true, merchantAccountRef: true,
        trackerToken: true, version: true } }));
    },
    /**
     * Refund reconciliation sweep: submits never-submitted REQUESTED rows, parks stale
     * SUBMITTING rows for review (their provider outcome is unknowable, so they are never
     * resubmitted), and re-polls the documented reporter endpoint for PENDING rows so
     * missing/delayed webhooks still finalize through authenticated evidence.
     */
    async reconcileDueRefunds(refunds: PaymentRefundService, provider: Pick<SafepayProvider, "fetchTracker">,
      input: { environment: "sandbox" | "production"; merchantAccountRef: string }, limit = 25) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid refund batch size.");
      const due = await refunds.dueForReconciliation(limit);
      const outcomes: Array<{ refundId: string; disposition: string; outcome?: string; code?: string }> = [];
      for (const row of due) {
        if (row.status === "REQUESTED") {
          const submitted = await refunds.submitRefund(row.id);
          outcomes.push({ refundId: row.id, disposition: "submitted", outcome: submitted.kind,
            ...("code" in submitted && submitted.code ? { code: submitted.code } : {}) });
          continue;
        }
        if (row.status === "SUBMITTING") {
          outcomes.push({ refundId: row.id, disposition: await refunds.abandonStaleSubmission(row.id) });
          continue;
        }
        // PENDING: poll the documented reporter endpoint once, then feed the response
        // bytes through the authenticated reconciliation channel. Finalization happens
        // only in settlement, from verified evidence.
        const fetched = await provider.fetchTracker({ trackerToken: row.trackerToken });
        if (fetched.kind !== "fetched") {
          await refunds.noteReconcileAttempt(row.id);
          outcomes.push({ refundId: row.id, disposition: "provider_fetch_failed", code: fetched.code });
          continue;
        }
        const observed = await this.observe({
          provider: "SAFEPAY", environment: input.environment, merchantAccountRef: input.merchantAccountRef,
          channel: "RECONCILIATION", body: fetched.bodyBytes, headers: {},
        });
        const noted = await refunds.noteReconcileAttempt(row.id);
        outcomes.push({ refundId: row.id, disposition: noted,
          outcome: observed.kind, ...("code" in observed ? { code: observed.code } : {}) });
      }
      return { considered: due.length, outcomes };
    },
  };
}
