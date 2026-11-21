// Order notifications (Phase 3, Chunk 7-final — D14/H-14).
//
// The customer emails for order/payment/refund events. Each function
// enqueues ONE outbox row for one event and never throws: enqueueing is
// best-effort and must never fail the order/payment operation that
// triggered it. A failure is reported through the existing error
// monitoring (captureError) and swallowed here, so callers just await the
// function after their own transaction has committed — no try/catch at
// the call site, no way for a mail problem to roll back an order.
//
// Enqueue points (each in the service layer, after commit):
// - placeOrder (COD): ORDER_CONFIRMED, fresh placement only — an
//   idempotency replay returns the old order without re-enqueueing.
// - Payment settlement (verified CAPTURE_CONFIRMED): ORDER_CONFIRMED +
//   ORDER_PAYMENT_SUCCEEDED, from the webhook service after apply().
// - adminUpdateOrderStatus: ORDER_STATUS for CONFIRMED/PROCESSING/SHIPPED/
//   DELIVERED, ORDER_CANCELLED for CANCELLED (both legacy and managed
//   branches, including paid cancel).
// - customerCancelOrder: ORDER_CANCELLED when the cancel just happened
//   (not on an already-cancelled replay).
// - resolveSafepayCancel (cancel page): ORDER_CANCELLED when the close
//   just happened (released / review_required, not already_closed).
// - Payment settlement (verified REFUND_CONFIRMED / REFUND_NOTICE):
//   ORDER_REFUND_SUCCEEDED, from the webhook service after apply().
// - Payment settlement (verified FAILURE_CONFIRMED): ORDER_PAYMENT_FAILED,
//   from the webhook service after apply(). Today no production adapter
//   emits FAILURE_CONFIRMED (verification.ts: a payment.failed webhook
//   never yields it — D5 pending), so this email cannot fire in
//   production until Safepay confirms a failure-final signal. The hook is
//   wired so that when finality is established, the email follows.
//
// Dedup: the payload is part of the outbox dedup key (type + email +
// payload), so the same event for the same order enqueues once while
// PENDING. The payload is the snapshot taken here — reference, total,
// status, refund amount — so the worker renders the email from the row
// alone and the email always reflects the event, even if the order
// changes afterwards.
//
// Only the six D14 events exist. No marketing copy, no extra events.
import "server-only";
import { db } from "@/lib/db";
import { captureError } from "@/lib/error-monitoring";
import {
  EMAIL_OUTBOX_TYPE_ORDER_CANCELLED,
  EMAIL_OUTBOX_TYPE_ORDER_CONFIRMED,
  EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_FAILED,
  EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_SUCCEEDED,
  EMAIL_OUTBOX_TYPE_ORDER_REFUND_SUCCEEDED,
  EMAIL_OUTBOX_TYPE_ORDER_STATUS,
  enqueueOrderNotificationEmail,
} from "@/services/email-outbox.service";

type OrderSnapshot = {
  id: string;
  reference: string;
  customerEmail: string;
  customerName: string | null;
  total: number;
  paymentMethod: string;
  carrier: string | null;
  trackingNumber: string | null;
};

async function loadOrder(orderId: string): Promise<OrderSnapshot | null> {
  return db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      reference: true,
      customerEmail: true,
      customerName: true,
      total: true,
      paymentMethod: true,
      carrier: true,
      trackingNumber: true,
    },
  });
}

async function loadOrderForPayment(paymentId: string): Promise<OrderSnapshot | null> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { orderId: true },
  });
  if (!payment) return null;
  return loadOrder(payment.orderId);
}

type OrderPayload = {
  orderId: string;
  reference: string;
  customerName: string | null;
  total: number;
  paymentMethod: string;
  status?: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  refundIds?: string[];
  refundAmountMinor?: string;
};

/** Build the payload with a fixed key order so the same event always
 * serializes to the same string — the payload is part of the dedup key. */
function orderPayload(order: OrderSnapshot, extra: Partial<OrderPayload> = {}): string {
  return JSON.stringify({
    orderId: order.id,
    reference: order.reference,
    customerName: order.customerName,
    total: order.total,
    paymentMethod: order.paymentMethod,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.carrier !== undefined ? { carrier: extra.carrier } : {}),
    ...(extra.trackingNumber !== undefined ? { trackingNumber: extra.trackingNumber } : {}),
    ...(extra.refundIds !== undefined ? { refundIds: extra.refundIds } : {}),
    ...(extra.refundAmountMinor !== undefined ? { refundAmountMinor: extra.refundAmountMinor } : {}),
  });
}

async function enqueue(type: string, order: OrderSnapshot | null, payload: string): Promise<void> {
  try {
    if (!order) {
      captureError(new Error("Order notification skipped: order not found."), {
        operation: "order-notification-enqueue",
      });
      return;
    }
    if (!order.customerEmail) {
      captureError(new Error("Order notification skipped: order has no customer email."), {
        operation: "order-notification-enqueue",
        eventId: order.id,
      });
      return;
    }
    await enqueueOrderNotificationEmail({ type, email: order.customerEmail, payload });
  } catch (error) {
    // Best-effort by design (D14): an enqueue failure must never fail the
    // order/payment operation. It is reported for operators; the order
    // itself already committed.
    captureError(error, { operation: "order-notification-enqueue" });
  }
}

async function enqueueForOrder(
  type: string,
  order: OrderSnapshot | null,
  extra: Partial<OrderPayload> = {}
): Promise<void> {
  await enqueue(type, order, order ? orderPayload(order, extra) : "");
}

/** Order confirmation: COD at placement; Safepay at verified settlement. */
export async function enqueueOrderConfirmedEmail(input: { orderId: string }): Promise<void> {
  const order = await loadOrder(input.orderId).catch((error) => {
    captureError(error, { operation: "order-notification-enqueue" });
    return null;
  });
  await enqueueForOrder(EMAIL_OUTBOX_TYPE_ORDER_CONFIRMED, order);
}

/** Status change: CONFIRMED / PROCESSING / SHIPPED / DELIVERED. The
 * payload carries the new status (and carrier/tracking for SHIPPED), so
 * one row per (order, status). */
export async function enqueueOrderStatusEmail(input: {
  orderId: string;
  status: string;
}): Promise<void> {
  const order = await loadOrder(input.orderId).catch((error) => {
    captureError(error, { operation: "order-notification-enqueue" });
    return null;
  });
  await enqueueForOrder(EMAIL_OUTBOX_TYPE_ORDER_STATUS, order, {
    status: input.status,
    carrier: order?.carrier ?? null,
    trackingNumber: order?.trackingNumber ?? null,
  });
}

/** Order cancellation: admin, customer, paid-cancel, and the Safepay
 * cancel page all funnel here. */
export async function enqueueOrderCancelledEmail(input: { orderId: string }): Promise<void> {
  const order = await loadOrder(input.orderId).catch((error) => {
    captureError(error, { operation: "order-notification-enqueue" });
    return null;
  });
  await enqueueForOrder(EMAIL_OUTBOX_TYPE_ORDER_CANCELLED, order);
}

/** Verified payment success: Safepay settlement only (CAPTURE_CONFIRMED),
 * never on tracker creation or the return page alone. */
export async function enqueueOrderPaymentSucceededEmail(input: {
  paymentId: string;
}): Promise<void> {
  const order = await loadOrderForPayment(input.paymentId).catch((error) => {
    captureError(error, { operation: "order-notification-enqueue" });
    return null;
  });
  await enqueueForOrder(EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_SUCCEEDED, order);
}

/** Final payment failure: only when provider finality is established (a
 * verified FAILURE_CONFIRMED observation). Never for a declined card or
 * an expired reservation — those are not final (D5 pending). */
export async function enqueueOrderPaymentFailedEmail(input: {
  paymentId: string;
}): Promise<void> {
  const order = await loadOrderForPayment(input.paymentId).catch((error) => {
    captureError(error, { operation: "order-notification-enqueue" });
    return null;
  });
  await enqueueForOrder(EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_FAILED, order);
}

/** Refund success: only after a refund is confirmed (settlement), never
 * on submission. One row per settled refund: the payload carries the
 * settled refund row ids and the amount, so two partial refunds for one
 * order are two distinct emails. */
export async function enqueueOrderRefundSucceededEmail(input: {
  paymentId: string;
  refundIds: string[];
  amountMinor: string;
}): Promise<void> {
  const order = await loadOrderForPayment(input.paymentId).catch((error) => {
    captureError(error, { operation: "order-notification-enqueue" });
    return null;
  });
  await enqueueForOrder(EMAIL_OUTBOX_TYPE_ORDER_REFUND_SUCCEEDED, order, {
    refundIds: input.refundIds,
    refundAmountMinor: input.amountMinor,
  });
}
