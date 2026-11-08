import "server-only";
import type { Payment, Prisma, PrismaClient } from "../../generated/postgres-client";
import { trackerIdentity, type PaymentObservation } from "@/lib/payments/evidence-contract";
import { readTrustedPaymentEvidence, type VerifiedEvidenceData } from "@/lib/payments/verified-evidence";

export type PaymentPersistence = Pick<PrismaClient, "$transaction">;
export type SettlementResult = { kind: "settled" | "already_settled" | "recorded" | "review_required" | "duplicate" } |
  { kind: "blocked"; code: "UNTRUSTED_EVIDENCE" | "EVENT_BINDING" | "IDENTITY_MISMATCH" | "BUSY" | "PERSISTENCE_UNAVAILABLE" };
class SettlementConflict extends Error {}
const include = { items: { orderBy: { productId: "asc" }, include: {
  inventoryReservation: { include: { inventory: true } },
} }, couponReservation: { include: { coupon: true } } } as const;
type ManagedOrder = Prisma.OrderGetPayload<{ include: typeof include }>;

function identityMatches(order: ManagedOrder | null, payment: Payment | null, o: PaymentObservation) {
  return !!order && !!payment && order.paymentFlowVersion === 1 && order.paymentMethod === "ONLINE" &&
    payment.orderId === order.id && payment.id === o.paymentId && order.id === o.orderId &&
    payment.provider === o.provider && payment.providerEnvironment === o.environment &&
    payment.merchantAccountRef === o.merchantAccountRef && payment.attemptNumber === o.attemptNumber &&
    !!payment.creationStartedAt && !!payment.trackerBoundAt && payment.trackerToken === o.trackerToken &&
    payment.trackerIdentityKey === trackerIdentity(o) && order.paymentOwnerOrderId === order.id &&
    order.currency === "PKR" && payment.currency === "PKR" && o.currency === "PKR" &&
    order.checkoutOwnerKind === o.owner.kind && order.checkoutOwnerHash === o.owner.hash &&
    o.owner.kind === "USER" && order.userId === o.owner.userId && !order.isGuest;
}
function validMoney(order: ManagedOrder, payment: Payment, o: PaymentObservation) {
  return Number.isSafeInteger(order.total) && order.total > 0 && payment.amount === order.total &&
    payment.expectedAmountMinor === BigInt(order.total) * BigInt(100) &&
    // The provider-reported amount, when the documented payload carried one, must equal
    // the attempt's expected amount. A null amount (documented shapes without financial
    // fields) has nothing to compare and is never treated as a match or a mismatch.
    (o.amountMinor === null || payment.expectedAmountMinor === BigInt(o.amountMinor)) &&
    (o.kind !== "CAPTURE_CONFIRMED" || (o.amountMinor !== null && o.capturedMinor === o.amountMinor &&
      (o.refundMinor === null || o.refundMinor === "0")));
}
function validSnapshot(order: ManagedOrder) {
  return order.items.length > 0 && order.items.every(item => Number.isSafeInteger(item.quantity) && item.quantity > 0 &&
    item.unitPrice > 0 && Number.isSafeInteger(item.quantity * item.unitPrice) && item.lineTotal === item.quantity * item.unitPrice) &&
    order.subtotal === order.items.reduce((sum, item) => sum + item.lineTotal, 0) &&
    [order.subtotal, order.discountTotal, order.deliveryFee, order.giftWrapCharge, order.taxTotal].every(v => Number.isSafeInteger(v) && v >= 0) &&
    order.discountTotal <= order.subtotal && order.total === order.subtotal - order.discountTotal + order.deliveryFee + order.giftWrapCharge + order.taxTotal;
}
function reservationsMatch(order: ManagedOrder, state: "HELD" | "CONSUMED") {
  return order.items.every(item => !!item.productId && !!item.inventoryReservation &&
    item.inventoryReservation.state === state && item.inventoryReservation.quantity === item.quantity &&
    item.inventoryReservation.inventory.productId === item.productId) &&
    (order.couponCode !== null ? !!order.couponReservation &&
      (state === "CONSUMED" || order.couponReservation.coupon.code === order.couponCode) &&
      order.couponReservation.state === (state === "HELD" ? "HELD" : "COMMITTED") : !order.couponReservation);
}

/** Provider-independent settlement. Its only entry requires an opaque verifier-issued proof and its durable inbox row. */
export function createPaymentSettlementService(database: PaymentPersistence, options: {
  now?: () => Date; reconcileDelayMs: number;
}) {
  if (!Number.isSafeInteger(options.reconcileDelayMs) || options.reconcileDelayMs < 1000 || options.reconcileDelayMs > 86_400_000)
    throw new Error("Invalid local reconciliation delay.");
  const clock = options.now ?? (() => new Date());
  return {
    async apply(proof: unknown, eventId: string): Promise<SettlementResult> {
      for (let retry = 0; retry < 3; retry++) {
        const now = clock(), verified = readTrustedPaymentEvidence(proof, now);
        if (!verified) return { kind: "blocked", code: "UNTRUSTED_EVIDENCE" };
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) return { kind: "blocked", code: "EVENT_BINDING" };
        const o = verified.observation;
        try {
          return await database.$transaction(async tx => {
            const event = await tx.paymentWebhookEvent.findUnique({ where: { id: eventId } });
            if (!event || event.provider !== o.provider || event.providerEnvironment !== o.environment ||
                event.merchantAccountRef !== o.merchantAccountRef || event.providerEventId !== o.observationId ||
                event.firstPayloadSha256 !== verified.rawSha256 || event.businessPayloadSha256 !== verified.businessSha256 ||
                event.trackerIdentityKey !== trackerIdentity(o) || event.normalizedPayloadJson !== normalizedEvidence(verified))
              return { kind: "blocked", code: "EVENT_BINDING" };
            if (event.reviewRequired || !["RECEIVED", "PROCESSED"].includes(event.processingStatus))
              return { kind: "review_required" };
            if (event.processedAt) return { kind: "duplicate" };
            const order = await tx.order.findUnique({ where: { id: o.orderId }, include });
            let payment = await tx.payment.findUnique({ where: { id: o.paymentId } });
            if (!identityMatches(order, payment, o) || !order || !payment) {
              await tx.paymentWebhookEvent.update({ where: { id: event.id }, data: {
                processingStatus: "REJECTED", processedAt: now, reviewRequired: true,
                reviewReason: "IDENTITY_MISMATCH", processingAttempts: { increment: 1 },
              } });
              return { kind: "blocked", code: "IDENTITY_MISMATCH" };
            }
            // Same first lock as cancellation/expiry/provider claims/admin fulfilment.
            if ((await tx.order.updateMany({ where: { id: order.id, version: order.version },
              data: { version: { increment: 1 } } })).count !== 1) throw new SettlementConflict();
            payment = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
            if (!identityMatches(order, payment, o)) throw new SettlementConflict();
            let paymentVersion = payment.version;
            const finish = async (decision: string, result: SettlementResult, reason?: string) => {
              if ((await tx.paymentWebhookEvent.updateMany({ where: { id: event.id, processedAt: null,
                processingStatus: "RECEIVED", reviewRequired: false, businessPayloadSha256: verified.businessSha256 },
              data: { paymentId: payment!.id, processingStatus: "PROCESSED", processedAt: now,
                processingAttempts: { increment: 1 }, leaseToken: null, leaseUntil: null,
              } })).count !== 1) throw new SettlementConflict();
              await tx.paymentEvidence.create({ data: { paymentId: payment!.id, source: verified.channel,
                operation: "PAYMENT_OBSERVATION", validationStatus: "AUTHENTICATED", decision, reasonCode: reason,
                sourceWebhookEventId: event.id, processedWebhookEventId: event.id,
                providerContractVersion: verified.contractVersion, rawPayloadSha256: verified.rawSha256,
                observedCurrency: o.currency,
                observedQuoteMinor: o.amountMinor === null ? null : BigInt(o.amountMinor),
                observedCapturedMinor: o.capturedMinor === null ? null : BigInt(o.capturedMinor),
                observedRefundedMinor: o.refundMinor === null ? null : BigInt(o.refundMinor),
                providerOccurredAt: o.occurredAt === null ? null : new Date(o.occurredAt),
                paymentVersion, orderVersion: order.version + 1,
              } });
              return result;
            };
            const changePayment = async (data: Prisma.PaymentUpdateManyMutationInput) => {
              if ((await tx.payment.updateMany({ where: { id: payment!.id, version: paymentVersion },
                data: { ...data, version: { increment: 1 } },
              })).count !== 1) throw new SettlementConflict();
              paymentVersion++;
            };
            const review = async (reason: string, reconcileStatus = "REVIEW_REQUIRED") => {
              await changePayment({ reconcileStatus, lastReconcileAt: now, nextReconcileAt: null,
                reconcileLeaseToken: null, reconcileLeaseUntil: null, reconcileAttempts: { increment: 1 } });
              await tx.order.update({ where: { id: order.id }, data: { paymentReviewStatus: "REQUIRED", paymentReviewReason: reason } });
              return finish("REVIEW_REQUIRED", { kind: "review_required" }, reason);
            };
            if (!validMoney(order, payment, o)) return review("AMOUNT_MISMATCH");
            if (!validSnapshot(order)) return review("ORDER_SNAPSHOT_MISMATCH");
            if (o.kind === "REFUND_NOTICE") return review("REFUND_REQUIRES_REVIEW");
            if (o.kind === "REVIEW_REQUIRED") return review("VERIFIER_REQUIRES_REVIEW");
            if (o.kind !== "CAPTURE_CONFIRMED" &&
                ((o.capturedMinor !== null && o.capturedMinor !== "0") || (o.refundMinor !== null && o.refundMinor !== "0")))
              return review("UNCLASSIFIED_FINANCIAL_AMOUNTS");
            const paid = payment.status === "PAID" && order.paymentStatus === "PAID" && order.acceptedPaymentId === payment.id &&
              !!payment.paidVerifiedAt && payment.capturedAmountMinor === payment.expectedAmountMinor &&
              (payment.refundedAmountMinor ?? BigInt(0)) === BigInt(0) && reservationsMatch(order, "CONSUMED");
            if (paid) {
              if (o.kind === "FAILURE_CONFIRMED") return review("FAILURE_AFTER_CAPTURE");
              // Older pending/uncertain observations and repeated captures never undo capture or fulfilment.
              return finish(o.kind === "CAPTURE_CONFIRMED" ? "ALREADY_SETTLED" : "STALE_OBSERVATION_IGNORED",
                { kind: o.kind === "CAPTURE_CONFIRMED" ? "already_settled" : "recorded" });
            }
            if (order.checkoutClosedAt || order.status !== "PENDING" || !order.reservationExpiresAt || order.reservationExpiresAt <= now)
              return review(o.kind === "CAPTURE_CONFIRMED" ? "LATE_CAPTURE" : "CLOSED_OR_EXPIRED_ORDER");
            if (order.activePaymentId !== payment.id || order.acceptedPaymentId !== null || order.paymentStatus !== "PENDING" ||
                payment.status !== "PENDING" || order.paymentReviewStatus !== "CLEAR" ||
                ["FAILED", "REVIEW_REQUIRED"].includes(payment.reconcileStatus ?? "") ||
                (payment.capturedAmountMinor ?? BigInt(0)) !== BigInt(0) || (payment.refundedAmountMinor ?? BigInt(0)) !== BigInt(0))
              return review("INELIGIBLE_PAYMENT_LIFECYCLE");
            if (o.kind !== "CAPTURE_CONFIRMED") {
              if (o.kind === "FAILURE_CONFIRMED") return review("FAILED_OBSERVATION_HOLDS_RETAINED", "FAILED");
              await changePayment({ reconcileStatus: o.kind, lastReconcileAt: now,
                nextReconcileAt: new Date(now.getTime() + options.reconcileDelayMs), reconcileAttempts: { increment: 1 },
                reconcileLeaseToken: null, reconcileLeaseUntil: null });
              return finish("OBSERVATION_RECORDED", { kind: "recorded" });
            }
            if (!reservationsMatch(order, "HELD")) return review("RESERVATION_MISMATCH");
            // Coupon row is locked before inventory-related rows, matching creation and closure.
            const couponHold = order.couponReservation;
            if (couponHold) {
              const coupon = couponHold.coupon;
              if (coupon.reservedCount < 1) return review("COUPON_COUNTER_MISMATCH");
              if ((await tx.coupon.updateMany({ where: { id: coupon.id, version: coupon.version,
                code: order.couponCode!, reservedCount: { gte: 1 }, usedCount: coupon.usedCount },
              data: { reservedCount: { decrement: 1 }, usedCount: { increment: 1 }, version: { increment: 1 } },
              })).count !== 1) throw new SettlementConflict();
              if ((await tx.couponReservation.updateMany({ where: { id: couponHold.id, version: couponHold.version, state: "HELD" },
                data: { state: "COMMITTED", committedAt: now, version: { increment: 1 } },
              })).count !== 1) throw new SettlementConflict();
            }
            for (const item of order.items) {
              const hold = item.inventoryReservation!;
              if ((await tx.inventoryReservation.updateMany({ where: { id: hold.id, version: hold.version, state: "HELD" },
                data: { state: "CONSUMED", consumedAt: now, version: { increment: 1 } },
              })).count !== 1) throw new SettlementConflict();
              // Inventory.quantity was already reduced when HELD: deliberately no stock write here.
            }
            await changePayment({ status: "PAID", attemptState: "SETTLED", capturedAmountMinor: BigInt(o.capturedMinor!),
              paidVerifiedAt: now, reconcileStatus: "VERIFIED", lastReconcileAt: now, nextReconcileAt: null,
              reconcileLeaseToken: null, reconcileLeaseUntil: null, reconcileAttempts: { increment: 1 } });
            await tx.order.update({ where: { id: order.id }, data: { status: "CONFIRMED", paymentStatus: "PAID",
              acceptedPaymentId: payment.id, paymentOwnerOrderId: order.id, paymentReviewStatus: "CLEAR", paymentReviewReason: null } });
            // If processing crosses the local hold deadline, roll back consumption/capture and
            // reevaluate with a fresh clock. A stale pre-transaction timestamp cannot settle an expired hold.
            if (clock() >= order.reservationExpiresAt) throw new SettlementConflict();
            return finish("SETTLED", { kind: "settled" });
          }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
          if ((error instanceof SettlementConflict || code === "P2034" || code === "P2002") && retry < 2) continue;
          return { kind: "blocked", code: error instanceof SettlementConflict || code === "P2034" || code === "P2028" ||
            code === "P2024" || code === "P2002" ? "BUSY" : "PERSISTENCE_UNAVAILABLE" };
        }
      }
      return { kind: "blocked", code: "BUSY" };
    },
  };
}

export function normalizedEvidence(data: VerifiedEvidenceData) {
  return JSON.stringify({ channel: data.channel, contractVersion: data.contractVersion, observation: data.observation });
}
