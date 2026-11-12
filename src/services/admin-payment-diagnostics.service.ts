import "server-only";
import { db } from "@/lib/db";

// Read-only Safepay payment diagnostics for the admin order detail page. Everything
// here is already available to administrators through the database; the loader only
// shapes it. It deliberately omits: tracker tokens, signed state values, webhook or
// reconciliation payload bytes, encryption material, provider credentials and customer
// PII beyond what the order page already shows. There is no write path in this file —
// re-verification goes through the guarded maintenance endpoint.

export type AdminPaymentDiagnostics = {
  managed: true;
  order: {
    id: string;
    reference: string;
    status: string;
    paymentStatus: string;
    paymentReviewStatus: string | null;
    paymentReviewReason: string | null;
    checkoutClosedAt: string | null;
    checkoutCloseReason: string | null;
    reservationExpiresAt: string | null;
    couponCode: string | null;
    currency: string;
    total: number;
  };
  payments: Array<{
    id: string;
    attemptNumber: number | null;
    attemptState: string | null;
    status: string;
    currency: string | null;
    amount: number;
    expectedAmountMinor: string | null;
    capturedAmountMinor: string | null;
    refundedAmountMinor: string | null;
    providerEnvironment: string | null;
    providerState: string | null;
    reconcileStatus: string | null;
    paidVerifiedAt: string | null;
    lastReconcileAt: string | null;
    nextReconcileAt: string | null;
    reconcileAttempts: number;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
    creationStartedAt: string | null;
    trackerBoundAt: string | null;
    hasBoundTracker: boolean;
  }>;
  reservations: Array<{ productName: string; quantity: number; state: string | null }>;
  couponReservationState: string | null;
  webhookEvents: Array<{
    processingStatus: string;
    reviewRequired: boolean;
    reviewReason: string | null;
    deliveryCount: number;
    firstReceivedAt: string | null;
    processedAt: string | null;
    eventType: string | null;
  }>;
  evidence: Array<{
    source: string;
    operation: string;
    validationStatus: string;
    decision: string;
    reasonCode: string | null;
    createdAt: string;
  }>;
  canRecheck: boolean;
};

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** Returns null for legacy/COD orders without a managed hosted-checkout flow. */
export async function adminGetPaymentDiagnostics(orderId: string): Promise<AdminPaymentDiagnostics | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) return null;
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, reference: true, status: true, paymentStatus: true, paymentFlowVersion: true,
      paymentReviewStatus: true, paymentReviewReason: true, checkoutClosedAt: true,
      checkoutCloseReason: true, reservationExpiresAt: true, couponCode: true, currency: true, total: true,
      acceptedPaymentId: true,
      items: {
        select: { productName: true, quantity: true, inventoryReservation: { select: { state: true } } },
        orderBy: { productId: "asc" },
      },
      couponReservation: { select: { state: true } },
    },
  }).catch(() => null);
  if (!order) return null;

  // Payments, inbox events and evidence are queried separately so no tracker token or
  // payload material is ever projected into application memory beyond existence checks.
  const paymentRows = await db.payment.findMany({
    where: { orderId, provider: "SAFEPAY" },
    orderBy: { attemptNumber: "asc" },
    select: {
      id: true, attemptNumber: true, attemptState: true, status: true, currency: true, amount: true,
      expectedAmountMinor: true, capturedAmountMinor: true, refundedAmountMinor: true,
      providerEnvironment: true, providerState: true, reconcileStatus: true, paidVerifiedAt: true,
      lastReconcileAt: true, nextReconcileAt: true, reconcileAttempts: true, lastErrorCode: true,
      lastErrorAt: true, creationStartedAt: true, trackerBoundAt: true, trackerToken: true,
    },
  });
  if (order.paymentFlowVersion !== 1 || paymentRows.length === 0) return null;

  const paymentIds = paymentRows.map(p => p.id);
  const events = await db.paymentWebhookEvent.findMany({
    where: { paymentId: { in: paymentIds } },
    orderBy: { firstReceivedAt: "asc" },
    select: {
      processingStatus: true, reviewRequired: true, reviewReason: true, deliveryCount: true,
      firstReceivedAt: true, processedAt: true, eventType: true,
    },
  });
  const evidence = await db.paymentEvidence.findMany({
    where: { paymentId: { in: paymentIds } },
    orderBy: { recordedAt: "desc" },
    take: 8,
    select: {
      source: true, operation: true, validationStatus: true, decision: true, reasonCode: true, recordedAt: true,
    },
  });

  const latest = [...paymentRows].filter(p => p.attemptNumber !== null).sort((a, b) => (b.attemptNumber ?? 0) - (a.attemptNumber ?? 0))[0];
  const canRecheck = !!latest && latest.status === "PENDING" && latest.trackerToken !== null &&
    ["PENDING", "UNCERTAIN"].includes(latest.reconcileStatus ?? "") &&
    order.status === "PENDING" && order.paymentStatus === "PENDING" &&
    order.checkoutClosedAt === null && order.acceptedPaymentId === null &&
    (order.paymentReviewStatus === null || order.paymentReviewStatus === "CLEAR");

  return {
    managed: true,
    order: {
      id: order.id, reference: order.reference, status: order.status, paymentStatus: order.paymentStatus,
      paymentReviewStatus: order.paymentReviewStatus, paymentReviewReason: order.paymentReviewReason,
      checkoutClosedAt: iso(order.checkoutClosedAt), checkoutCloseReason: order.checkoutCloseReason,
      reservationExpiresAt: iso(order.reservationExpiresAt), couponCode: order.couponCode,
      currency: order.currency ?? "PKR", total: order.total,
    },
    payments: paymentRows.map(p => ({
      id: p.id, attemptNumber: p.attemptNumber, attemptState: p.attemptState, status: p.status,
      currency: p.currency, amount: p.amount,
      expectedAmountMinor: p.expectedAmountMinor === null ? null : p.expectedAmountMinor.toString(),
      capturedAmountMinor: p.capturedAmountMinor === null ? null : p.capturedAmountMinor.toString(),
      refundedAmountMinor: p.refundedAmountMinor === null ? null : p.refundedAmountMinor.toString(),
      providerEnvironment: p.providerEnvironment, providerState: p.providerState,
      reconcileStatus: p.reconcileStatus, paidVerifiedAt: iso(p.paidVerifiedAt),
      lastReconcileAt: iso(p.lastReconcileAt), nextReconcileAt: iso(p.nextReconcileAt),
      reconcileAttempts: p.reconcileAttempts, lastErrorCode: p.lastErrorCode, lastErrorAt: iso(p.lastErrorAt),
      creationStartedAt: iso(p.creationStartedAt), trackerBoundAt: iso(p.trackerBoundAt),
      hasBoundTracker: p.trackerToken !== null,
    })),
    reservations: order.items.map(item => ({
      productName: item.productName, quantity: item.quantity,
      state: item.inventoryReservation?.state ?? null,
    })),
    couponReservationState: order.couponReservation?.state ?? null,
    webhookEvents: events.map(e => ({
      processingStatus: e.processingStatus, reviewRequired: e.reviewRequired, reviewReason: e.reviewReason,
      deliveryCount: e.deliveryCount, firstReceivedAt: iso(e.firstReceivedAt), processedAt: iso(e.processedAt),
      eventType: e.eventType,
    })),
    evidence: evidence.map(e => ({
      source: e.source, operation: e.operation, validationStatus: e.validationStatus,
      decision: e.decision, reasonCode: e.reasonCode, createdAt: e.recordedAt.toISOString(),
    })),
    canRecheck,
  };
}
