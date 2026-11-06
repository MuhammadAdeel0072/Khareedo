import "server-only";
import { sha256, trackerIdentity, type VerificationInput } from "@/lib/payments/evidence-contract";
import { authenticatePaymentEvidence, copyVerificationInput, readTrustedPaymentEvidence } from "@/lib/payments/verified-evidence";
import type { PaymentPayloadVault } from "@/lib/payments/payload-vault";
import { createPaymentSettlementService, normalizedEvidence, type PaymentPersistence, type SettlementResult } from "@/services/payment-settlement.service";

export type InboxReceiveResult = { kind: "stored" | "duplicate" | "quarantined" | "conflict"; eventId: string } |
  { kind: "blocked"; code: "INVALID_INPUT" | "BUSY" | "PERSISTENCE_UNAVAILABLE" };

/** Durable authenticated-observation inbox. Also stores reconciliation responses in the existing event table. */
export function createPaymentWebhookService(database: PaymentPersistence, vault: PaymentPayloadVault, options: {
  now?: () => Date; reconcileDelayMs: number;
}) {
  const clock = options.now ?? (() => new Date());
  const settlement = createPaymentSettlementService(database, options);
  return {
    async receive(raw: VerificationInput): Promise<InboxReceiveResult> {
      let input: VerificationInput;
      try { input = copyVerificationInput(raw); } catch { return { kind: "blocked", code: "INVALID_INPUT" }; }
      const now = clock(), authenticated = await authenticatePaymentEvidence(input, now);
      const data = authenticated.kind === "verified" ? readTrustedPaymentEvidence(authenticated.proof, now) : null;
      const rawHash = sha256(input.body);
      const dedupKey = sha256(JSON.stringify(["KHAREEDO_PAYMENT_INBOX_V1", input.channel, input.provider,
        input.environment, input.merchantAccountRef, data ? "AUTHENTICATED_ID" : "UNVERIFIED_BODY",
        data?.observation.observationId ?? rawHash]));
      let encrypted;
      try {
        encrypted = vault.seal({ ...input, headers: authenticated.kind === "verified" ? authenticated.retainedHeaders : {} },
          { provider: input.provider, environment: input.environment, merchantAccountRef: input.merchantAccountRef,
            dedupKey, firstPayloadSha256: rawHash });
      } catch { return { kind: "blocked", code: "PERSISTENCE_UNAVAILABLE" }; }
      for (let retry = 0; retry < 3; retry++) {
        try {
          return await database.$transaction(async tx => {
            const existing = await tx.paymentWebhookEvent.findUnique({ where: { dedupKey } });
            if (existing) {
              const conflict = !!data && existing.businessPayloadSha256 !== data.businessSha256;
              // A verified reused identity with different business facts is an authenticated anomaly.
              // Lock Order before Payment/Event, matching settlement and cancellation. Never change money/stock.
              if (conflict && existing.paymentId) {
                const payment = await tx.payment.findUnique({ where: { id: existing.paymentId } });
                if (payment) {
                  await tx.order.update({ where: { id: payment.orderId }, data: { paymentReviewStatus: "REQUIRED",
                    paymentReviewReason: "EVENT_ID_CONFLICT", version: { increment: 1 } } });
                  await tx.payment.update({ where: { id: payment.id }, data: { reconcileStatus: "REVIEW_REQUIRED",
                    nextReconcileAt: null, reconcileLeaseToken: null, reconcileLeaseUntil: null, version: { increment: 1 } } });
                }
              }
              await tx.paymentWebhookEvent.update({ where: { id: existing.id }, data: {
                lastReceivedAt: now, deliveryCount: { increment: 1 }, lastPayloadSha256: rawHash,
                ...(conflict ? { reviewRequired: true, reviewReason: "EVENT_ID_CONFLICT", processingStatus: "REVIEW_REQUIRED" } : {}),
              } });
              return { kind: conflict ? "conflict" : data ? "duplicate" : "quarantined", eventId: existing.id };
            }
            const event = await tx.paymentWebhookEvent.create({ data: {
              provider: input.provider, providerEnvironment: input.environment, merchantAccountRef: input.merchantAccountRef,
              dedupKey, firstPayloadSha256: rawHash, lastPayloadSha256: rawHash, ...encrypted,
              payloadFormat: "KHAREEDO_ENCRYPTED_OBSERVATION_V1", firstReceivedAt: now, lastReceivedAt: now, nextProcessAt: now,
              providerEventId: data?.observation.observationId, eventType: data?.observation.kind,
              trackerToken: data?.observation.trackerToken,
              trackerIdentityKey: data ? trackerIdentity(data.observation) : null,
              businessPayloadSha256: data?.businessSha256, normalizedPayloadJson: data ? normalizedEvidence(data) : null,
              providerOccurredAt: data?.observation.occurredAt ? new Date(data.observation.occurredAt) : null,
              processingStatus: data ? "RECEIVED" : "QUARANTINED", reviewRequired: !data,
              reviewReason: data ? null : "PROVIDER_VERIFICATION_UNAVAILABLE_OR_INVALID",
              // No invented provider event version, signing header, signature profile or signing-key identity.
            }, select: { id: true } });
            return { kind: data ? "stored" : "quarantined", eventId: event.id };
          }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
          if ((code === "P2002" || code === "P2034") && retry < 2) continue;
          return { kind: "blocked", code: ["P2002", "P2034", "P2028", "P2024"].includes(String(code)) ? "BUSY" : "PERSISTENCE_UNAVAILABLE" };
        }
      }
      return { kind: "blocked", code: "BUSY" };
    },
    async process(eventId: string): Promise<SettlementResult | { kind: "blocked"; code: "VERIFICATION_DISABLED" | "UNVERIFIED_EVIDENCE" | "PAYLOAD_UNAVAILABLE" }> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) return { kind: "blocked", code: "EVENT_BINDING" };
      try {
        const event = await database.$transaction(tx => tx.paymentWebhookEvent.findUnique({ where: { id: eventId } }));
        if (!event) return { kind: "blocked", code: "EVENT_BINDING" };
        if (event.reviewRequired || !["RECEIVED", "PROCESSED"].includes(event.processingStatus)) return { kind: "review_required" };
        if (event.processedAt) return { kind: "duplicate" };
        const unavailable = async () => {
          await database.$transaction(tx => tx.paymentWebhookEvent.updateMany({ where: { id: event.id,
            processedAt: null, processingStatus: "RECEIVED" },
          data: { processingStatus: "REVIEW_REQUIRED", reviewRequired: true, reviewReason: "PAYLOAD_UNAVAILABLE_OR_UNAUTHENTICATED" } }));
          return { kind: "blocked" as const, code: "PAYLOAD_UNAVAILABLE" as const };
        };
        if (event.payloadPurgedAt || !event.payloadKeyId || !event.payloadCiphertext || !event.payloadNonce || !event.payloadAuthTag)
          return await unavailable();
        let input: VerificationInput;
        try {
          input = vault.open({ payloadKeyId: event.payloadKeyId, payloadCiphertext: event.payloadCiphertext,
            payloadNonce: event.payloadNonce, payloadAuthTag: event.payloadAuthTag },
          { provider: event.provider, environment: event.providerEnvironment, merchantAccountRef: event.merchantAccountRef,
            dedupKey: event.dedupKey, firstPayloadSha256: event.firstPayloadSha256 });
        } catch { return await unavailable(); }
        if (sha256(input.body) !== event.firstPayloadSha256) return await unavailable();
        // Always reauthenticate original encrypted bytes/approved headers, including after a process restart.
        // A persisted VERIFIED flag or normalized JSON is never a settlement capability.
        const verified = await authenticatePaymentEvidence(input, clock());
        if (verified.kind !== "verified") return { kind: "blocked", code: verified.code === "VERIFICATION_DISABLED" ? verified.code : "UNVERIFIED_EVIDENCE" };
        return await settlement.apply(verified.proof, eventId);
      } catch { return { kind: "blocked", code: "PERSISTENCE_UNAVAILABLE" }; }
    },
    async pending(limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid inbox batch size.");
      return database.$transaction(tx => tx.paymentWebhookEvent.findMany({ where: { processingStatus: "RECEIVED",
        reviewRequired: false, processedAt: null, nextProcessAt: { lte: clock() } },
      orderBy: [{ nextProcessAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } }));
    },
  };
}
export type PaymentWebhookService = ReturnType<typeof createPaymentWebhookService>;
