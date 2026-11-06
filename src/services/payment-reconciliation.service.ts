import "server-only";
import type { VerificationInput } from "@/lib/payments/evidence-contract";
import type { PaymentPersistence } from "@/services/payment-settlement.service";
import type { PaymentWebhookService } from "@/services/payment-webhook.service";

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
  };
}
