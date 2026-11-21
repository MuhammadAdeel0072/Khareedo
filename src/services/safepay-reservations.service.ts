import "server-only";
import type { Order, Prisma } from "../../generated/postgres-client";
import type { db } from "@/lib/db";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@/lib/constants";
import { wholePkrToMinor } from "@/lib/safepay/contracts";
import { bindCheckoutOwner, type OwnerBinding, type PaymentDatabase, type TrustedCheckoutOwner } from "@/services/safepay-attempt.store";
import { recordOrderStatusHistory } from "@/services/order-status-history.service";

export type ReservationCloseResult = { ok: true; outcome: "RELEASED" | "REVIEW_REQUIRED" | "ALREADY_CLOSED" | "SETTLED" } |
  { ok: false; error: string };

/**
 * Pre-expiry provider consult for expireBatch (M-26). One verification
 * attempt for one payment, returning the verification outcome kind. The
 * reservation service never calls the provider itself — the caller injects
 * the consult (the maintenance runner builds it from the payment stack).
 */
export type ExpiryProviderCheck = (paymentId: string) => Promise<
  | { kind: "settled" | "already_settled" | "recorded" | "review_required" | "stored" | "quarantined" | "duplicate" | "conflict" }
  | { kind: "blocked"; code: string }
  | { kind: "provider_fetch_failed"; code: string }
  | { kind: "skipped"; code: string }
>;
export class ReservationIntegrityError extends Error {}
const failure = (error: string): ReservationCloseResult => ({ ok: false, error });

/** Locks the same Order row as the provider's durable creation claim. Never guesses provider finality. */
export async function closeManagedPendingOrder(tx: Prisma.TransactionClient, orderId: string,
  reason: "CANCELLED" | "EXPIRED", now: Date, owner?: OwnerBinding,
  cancel?: { by: string; reason: string | null }): Promise<ReservationCloseResult> {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || order.paymentFlowVersion !== 1 || order.paymentMethod !== "ONLINE" ||
      (owner && (order.checkoutOwnerKind !== owner.kind || order.checkoutOwnerHash !== owner.hash || order.userId !== owner.userId)))
    return failure("Order not found or not eligible.");
  if (order.checkoutClosedAt && order.status === "CANCELLED") return { ok: true, outcome: "ALREADY_CLOSED" };
  if (order.status !== "PENDING" || order.paymentStatus !== "PENDING" || order.acceptedPaymentId !== null)
    return failure("This order requires payment review before cancellation.");
  if (reason === "EXPIRED" && (!order.reservationExpiresAt || order.reservationExpiresAt > now))
    return failure("The reservation has not expired.");
  if ((await tx.order.updateMany({ where: { id: orderId, version: order.version, status: "PENDING",
    paymentStatus: "PENDING", acceptedPaymentId: null, checkoutClosedAt: null },
  data: { version: { increment: 1 } } })).count !== 1) return failure("The order changed. Please retry.");

  const payments = await tx.payment.findMany({ where: { orderId }, orderBy: { attemptNumber: "asc" } });
  if (!payments.length || payments.some(payment => payment.provider !== "SAFEPAY" || payment.status !== "PENDING" ||
      (payment.capturedAmountMinor ?? BigInt(0)) !== BigInt(0) || (payment.refundedAmountMinor ?? BigInt(0)) !== BigInt(0)))
    throw new ReservationIntegrityError("Payment state requires review; no reservations were released.");
  const mayBePayable = payments.some(payment => payment.creationStartedAt !== null || payment.trackerToken !== null ||
    payment.reference !== null || payment.retryRequestKey !== null || payment.attemptState !== "READY");
  if (!mayBePayable) {
    const items = await tx.orderItem.findMany({ where: { orderId }, orderBy: { productId: "asc" }, include: {
      inventoryReservation: { include: { inventory: true } },
    } });
    if (!items.length) throw new ReservationIntegrityError("Missing order reservations.");
    // Acquire coupon before inventory, matching creation's lock order.
    const couponHold = await tx.couponReservation.findUnique({ where: { orderId } });
    if (!!order.couponCode !== !!couponHold) throw new ReservationIntegrityError("Missing coupon reservation.");
    if (couponHold) {
      if (couponHold.state !== "HELD" || (await tx.coupon.updateMany({
        where: { id: couponHold.couponId, code: order.couponCode!, reservedCount: { gte: 1 } },
        data: { reservedCount: { decrement: 1 }, version: { increment: 1 } },
      })).count !== 1) throw new ReservationIntegrityError("Coupon reservation counter mismatch.");
      if ((await tx.couponReservation.updateMany({ where: { id: couponHold.id, version: couponHold.version, state: "HELD" },
        data: { state: "RELEASED", releasedAt: now, releaseReason: reason, version: { increment: 1 } },
      })).count !== 1) throw new ReservationIntegrityError("Coupon reservation changed.");
    }
    for (const item of items) {
      const hold = item.inventoryReservation;
      if (!hold || hold.state !== "HELD" || hold.quantity !== item.quantity || hold.inventory.productId !== item.productId)
        throw new ReservationIntegrityError("Inventory reservation mismatch.");
      if ((await tx.inventory.updateMany({ where: { id: hold.inventoryId },
        data: { quantity: { increment: hold.quantity }, version: { increment: 1 } } })).count !== 1)
        throw new ReservationIntegrityError("Inventory reservation could not be restored.");
      if ((await tx.inventoryReservation.updateMany({ where: { id: hold.id, version: hold.version, state: "HELD" },
        data: { state: "RELEASED", releasedAt: now, releaseReason: reason, version: { increment: 1 } },
      })).count !== 1) throw new ReservationIntegrityError("Inventory reservation changed.");
    }
  }
  await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", checkoutClosedAt: now,
    checkoutCloseReason: reason, paymentReviewStatus: mayBePayable ? "REQUIRED" : "CLEAR",
    paymentReviewReason: mayBePayable ? "PROVIDER_FINALITY_UNVERIFIED" : null,
    // A cancelled unpaid order's payment is CANCELLED (D2/M-7) — but only
    // once finality is established. When the payment may have been captured
    // at the provider (mayBePayable), it stays PENDING until the review
    // resolves it; marking it CANCELLED now would hide a real capture.
    ...(!mayBePayable ? { paymentStatus: "CANCELLED" } : {}),
    cancelledAt: now,
    ...(cancel ? { cancelledBy: cancel.by, cancelReason: cancel.reason } : {}),
  } });
  // Status history (M-6): the close is the CANCELLED transition.
  await recordOrderStatusHistory(tx, {
    orderId,
    status: "CANCELLED",
    actor: cancel?.by ?? "system",
    note: cancel?.reason ?? null,
  });
  for (const payment of payments) {
    if ((await tx.payment.updateMany({ where: { id: payment.id, version: payment.version }, data: {
      ...(!mayBePayable ? { attemptState: "CLOSED", status: "CANCELLED" } : {}),
      reconcileStatus: mayBePayable ? "REVIEW_REQUIRED" : "NOT_REQUIRED", version: { increment: 1 },
    } })).count !== 1) throw new ReservationIntegrityError("Payment attempt changed during closure.");
    await tx.paymentEvidence.create({ data: { paymentId: payment.id, source: "LOCAL", operation: "CLOSE_CHECKOUT",
      validationStatus: "LOCAL_VALIDATED", decision: mayBePayable ? "HOLDS_RETAINED_FOR_REVIEW" : "RESERVATIONS_RELEASED",
      reasonCode: reason, paymentVersion: payment.version + 1, orderVersion: order.version + 1,
    } });
  }
  // Financial PENDING remains PENDING only while provider finality is
  // unverified (mayBePayable): local cancellation is not a provider
  // failure/refund, and the review resolves it. When no provider interaction
  // was possible, the payment is definitively cancelled above.
  return { ok: true, outcome: mayBePayable ? "REVIEW_REQUIRED" : "RELEASED" };
}

/** A paid label alone cannot authorize fulfilment or another stock decrement. */
export async function canFulfilManagedOrder(tx: Prisma.TransactionClient, order: Order): Promise<boolean> {
  if (order.paymentFlowVersion !== 1 || order.paymentMethod !== "ONLINE" || order.checkoutClosedAt ||
      order.paymentStatus !== "PAID" || order.paymentReviewStatus !== "CLEAR" || !order.acceptedPaymentId ||
      order.paymentOwnerOrderId !== order.id || order.currency !== "PKR") return false;
  const payment = await tx.payment.findUnique({ where: { id: order.acceptedPaymentId } });
  if (!payment || payment.orderId !== order.id || payment.provider !== "SAFEPAY" || payment.status !== "PAID" ||
      !payment.paidVerifiedAt || payment.currency !== "PKR" || payment.amount !== order.total ||
      payment.reconcileStatus !== "VERIFIED" || (payment.refundedAmountMinor ?? BigInt(0)) !== BigInt(0)) return false;
  try {
    if (payment.expectedAmountMinor !== wholePkrToMinor(order.total) || payment.capturedAmountMinor !== payment.expectedAmountMinor)
      return false;
  } catch { return false; }
  const items = await tx.orderItem.findMany({ where: { orderId: order.id }, include: {
    inventoryReservation: { include: { inventory: true } },
  } });
  if (!items.length || items.some(item => !item.inventoryReservation || item.inventoryReservation.state !== "CONSUMED" ||
      item.inventoryReservation.quantity !== item.quantity || item.inventoryReservation.inventory.productId !== item.productId)) return false;
  const coupon = await tx.couponReservation.findUnique({ where: { orderId: order.id } });
  return order.couponCode ? coupon?.state === "COMMITTED" : coupon === null;
}

/**
 * Cancel a settled managed order — verified capture, consumed holds (H-12,
 * D1/D2). Restocks inventory (CONSUMED → RESTORED + restoredAt), frees the
 * committed coupon use, and marks the order CANCELLED with payment status
 * CANCELLED. The captured payment row stays PAID: its money moves only
 * through the existing manual/admin refund flow.
 *
 * NO provider call is made here, and no reversal/refund is submitted. D6 is
 * still pending — no Safepay reversal API has been confirmed — so a refund
 * for this order remains a manual admin action (refund UI + payment-refund
 * service). This function only restocks and cancels; it never moves money.
 *
 * The gate is the same bar as fulfilment (canFulfilManagedOrder): a merely
 * PAID-labelled order without verified capture and consumed holds is
 * refused — cancelling it would restock against money that may never have
 * arrived. A partially-refunded order is likewise refused (refunded money
 * already moved); that needs manual review.
 */
export async function cancelPaidManagedOrder(
  tx: Prisma.TransactionClient,
  order: Order,
  now: Date,
  cancel: { by: string; reason: string | null }
): Promise<{ ok: true; couponRestored: boolean } | { ok: false; error: string }> {
  if (!(await canFulfilManagedOrder(tx, order))) {
    return {
      ok: false,
      error: "This order can only be cancelled once its payment is verified as captured. It needs payment review first.",
    };
  }

  // Claim exactly once: a second cancel (admin or customer) finds the claim
  // already spent and is refused, so stock is restored exactly once.
  const claimed = await tx.order.updateMany({
    where: {
      id: order.id,
      version: order.version,
      status: order.status,
      paymentStatus: "PAID",
      acceptedPaymentId: order.acceptedPaymentId,
      checkoutClosedAt: null,
    },
    data: { version: { increment: 1 } },
  });
  if (claimed.count !== 1) return { ok: false, error: "The order changed. Please retry." };

  const items = await tx.orderItem.findMany({
    where: { orderId: order.id },
    include: { inventoryReservation: { include: { inventory: true } } },
  });
  if (!items.length) throw new ReservationIntegrityError("Missing order reservations.");
  for (const item of items) {
    const hold = item.inventoryReservation;
    if (!hold || hold.state !== "CONSUMED" || hold.quantity !== item.quantity || hold.inventory.productId !== item.productId)
      throw new ReservationIntegrityError("Inventory reservation mismatch.");
    if (
      (await tx.inventory.updateMany({
        where: { id: hold.inventoryId },
        data: { quantity: { increment: hold.quantity }, version: { increment: 1 } },
      })).count !== 1
    )
      throw new ReservationIntegrityError("Inventory reservation could not be restored.");
    if (
      (await tx.inventoryReservation.updateMany({
        where: { id: hold.id, version: hold.version, state: "CONSUMED" },
        data: { state: "RESTORED", restoredAt: now, version: { increment: 1 } },
      })).count !== 1
    )
      throw new ReservationIntegrityError("Inventory reservation changed.");
  }

  // Coupon: the committed use is freed (usedCount CAS decrement, mirroring
  // the legacy path) so the coupon's capacity is restored. The reservation
  // row itself stays COMMITTED: the DB CHECK (CouponReservation_state_check,
  // Postgres + SQLite harness) only permits RELEASED from HELD
  // (committedAt IS NULL), so COMMITTED is terminal for the row — it is the
  // durable record that this coupon was committed to this order. The counter
  // is what gates future redemptions, not the row state; a per-user
  // redemption check (D11, Chunk 11) must therefore exclude cancelled
  // orders rather than treating a COMMITTED row as an active use.
  const couponHold = await tx.couponReservation.findUnique({ where: { orderId: order.id } });
  if (!!order.couponCode !== !!couponHold)
    throw new ReservationIntegrityError("Coupon reservation mismatch.");
  let couponRestored = false;
  if (couponHold) {
    if (couponHold.state !== "COMMITTED")
      throw new ReservationIntegrityError("Coupon reservation is not COMMITTED.");
    if (
      (await tx.coupon.updateMany({
        where: { id: couponHold.couponId, code: order.couponCode!, usedCount: { gte: 1 } },
        data: { usedCount: { decrement: 1 }, version: { increment: 1 } },
      })).count !== 1
    )
      throw new ReservationIntegrityError("Coupon usage counter mismatch.");
    couponRestored = true;
  }

  await tx.order.update({
    where: { id: order.id },
    data: {
      status: "CANCELLED",
      paymentStatus: "CANCELLED",
      checkoutClosedAt: now,
      checkoutCloseReason: "CANCELLED",
      cancelledAt: now,
      cancelledBy: cancel.by,
      cancelReason: cancel.reason,
    },
  });

  // Status history (M-6): the paid cancel is the CANCELLED transition.
  await recordOrderStatusHistory(tx, {
    orderId: order.id,
    status: "CANCELLED",
    actor: cancel.by,
    note: cancel.reason,
  });

  // Unpaid attempts on this order are cancelled. The captured payment stays
  // PAID — its money moves only through the manual refund flow (D6 pending).
  await tx.payment.updateMany({
    where: { orderId: order.id, status: "PENDING" },
    data: { status: "CANCELLED", version: { increment: 1 } },
  });

  // Evidence trail, mirroring closeManagedPendingOrder.
  const payments = await tx.payment.findMany({ where: { orderId: order.id } });
  for (const payment of payments) {
    await tx.paymentEvidence.create({
      data: {
        paymentId: payment.id,
        source: "LOCAL",
        operation: "CANCEL_PAID_ORDER",
        validationStatus: "LOCAL_VALIDATED",
        decision: "RESERVATIONS_RESTORED",
        reasonCode: "CANCELLED",
        paymentVersion: payment.version,
        orderVersion: order.version + 1,
      },
    });
  }

  return { ok: true, couponRestored };
}

/** Admin-only caller supplies its authorized transaction. Never performs settlement. */
export async function updateManagedOrderStatus(transaction: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  orderId: string, next: OrderStatus, now: Date,
  cancel?: { by: string; reason: string | null },
  fulfilment?: { carrier?: string | null; trackingNumber?: string | null }) {
  // The application adds query timing through $extends. It preserves native delegates
  // at runtime but Prisma's generated extension generics are not structurally assignable.
  const tx = transaction as unknown as Prisma.TransactionClient;
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || !ORDER_STATUS_TRANSITIONS[order.status as OrderStatus]?.includes(next))
    return { ok: false, error: "Cannot apply this order status transition." };
  if (next === "CANCELLED") {
    // A settled order (verified capture, consumed holds) cancels through the
    // paid path, which restocks; anything else goes through the pending close.
    if (order.paymentStatus === "PAID" && order.acceptedPaymentId) {
      return cancelPaidManagedOrder(tx, order, now, cancel ?? { by: "system:unknown", reason: null });
    }
    return closeManagedPendingOrder(tx, orderId, "CANCELLED", now, undefined, cancel);
  }
  if (!await canFulfilManagedOrder(tx, order)) return { ok: false, error: "Verified payment and consumed reservations are required before fulfilment." };
  const changed = await tx.order.updateMany({ where: { id: order.id, version: order.version, status: order.status,
    paymentStatus: "PAID", acceptedPaymentId: order.acceptedPaymentId, checkoutClosedAt: null, paymentReviewStatus: "CLEAR" },
  data: { status: next, version: { increment: 1 },
    // Shipment tracking (D4): the admin enters carrier/tracking when marking
    // an order SHIPPED; store them on the same write as the transition.
    ...(next === "SHIPPED" && fulfilment?.carrier ? { carrier: fulfilment.carrier } : {}),
    ...(next === "SHIPPED" && fulfilment?.trackingNumber ? { trackingNumber: fulfilment.trackingNumber } : {}),
  } });
  return changed.count === 1 ? { ok: true } : { ok: false, error: "The order changed. Please retry." };
}

/**
 * Pre-close provider consult (M-26). Before an expired reservation is
 * closed, ask the provider — through the injected verification — whether
 * the payment actually completed, so a late success is not lost to expiry.
 *
 * Only a payment with a bound tracker can carry provider state worth
 * consulting; a never-started attempt has nothing to ask about and closes
 * as before. The consult's outcomes map as follows:
 * - settled / already_settled: the payment settled — do not expire it. The
 *   order is re-read to confirm it actually left PENDING; a claim of
 *   settlement with the order still PENDING is inconsistent, so it defers
 *   (the next sweep re-checks) instead of closing blind.
 * - recorded / review_required / stored / quarantined / duplicate /
 *   conflict: the provider was consulted in this sweep and the outcome is
 *   recorded. A capture observation is now LATE_CAPTURE evidence the
 *   review queue can resolve immediately (investigated, capture present),
 *   and a non-capture means the close is safe. Either way the close
 *   retains holds for review when the payment may be payable.
 * - provider_fetch_failed / blocked / skipped: the provider could not be
 *   consulted this sweep. The close proceeds anyway — the close retains
 *   holds for review and the investigate action consults the provider
 *   later. Deferring instead would strand the reservation: a deferred
 *   order stays PENDING with an expired reservation, invisible to the
 *   review queue and unresolvable until it is closed.
 * With no verifier injected (callers without provider access), tracker-
 * bearing candidates close as before — the pre-expiry maintenance action
 * is the primary check, and this consult is its last-millisecond backstop.
 */
async function checkBeforeExpiry(database: PaymentDatabase, orderId: string,
  verify: ExpiryProviderCheck | undefined): Promise<"proceed" | "settled" | "deferred"> {
  const payments = await database.$transaction(tx => tx.payment.findMany({ where: { orderId, provider: "SAFEPAY" },
    orderBy: [{ attemptNumber: "desc" }, { id: "desc" }],
    select: { id: true, trackerToken: true } }));
  const tracked = payments.find(payment => payment.trackerToken !== null);
  if (!tracked || !verify) return "proceed";
  let outcome: Awaited<ReturnType<ExpiryProviderCheck>>;
  try {
    outcome = await verify(tracked.id);
  } catch {
    return "proceed"; // a failed check must never block the close
  }
  if (outcome.kind === "settled" || outcome.kind === "already_settled") {
    const order = await database.$transaction(tx => tx.order.findUnique({ where: { id: orderId }, select: { status: true } }));
    return order && order.status !== "PENDING" ? "settled" : "deferred";
  }
  return "proceed";
}

export function createSafepayReservationService(database: PaymentDatabase, clock = () => new Date(),
  options?: { verifyPayment?: ExpiryProviderCheck }) {
  return {
    async cancel(orderId: string, principal: TrustedCheckoutOwner): Promise<ReservationCloseResult> {
      try {
        const owner = bindCheckoutOwner(principal);
        return await database.$transaction(tx => closeManagedPendingOrder(tx, orderId, "CANCELLED", clock(), owner,
          { by: `customer:${owner.userId}`, reason: null }),
          { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
      } catch { return failure("The reservation could not be closed safely. Retry or request review."); }
    },
    // Explicit invocation only; no scheduled worker or public endpoint is enabled.
    async expireBatch(limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid expiration batch size.");
      const now = clock();
      const candidates = await database.$transaction(tx => tx.order.findMany({ where: {
        paymentFlowVersion: 1, status: "PENDING", checkoutClosedAt: null, reservationExpiresAt: { lte: now },
      }, orderBy: [{ reservationExpiresAt: "asc" }, { id: "asc" }], take: limit, select: { id: true } }));
      const results: Array<{ orderId: string; result: ReservationCloseResult }> = [];
      for (const candidate of candidates) {
        let result: ReservationCloseResult;
        try {
          // M-26: consult the provider before closing a possibly-paid
          // tracker. A settled payment is never expired; every other
          // outcome proceeds to the close (see checkBeforeExpiry).
          const preCheck = await checkBeforeExpiry(database, candidate.id, options?.verifyPayment);
          if (preCheck === "settled") {
            results.push({ orderId: candidate.id, result: { ok: true, outcome: "SETTLED" } });
            continue;
          }
          if (preCheck === "deferred") {
            result = failure("The payment could not be verified before expiry; the reservation was left open for a later sweep.");
            results.push({ orderId: candidate.id, result });
            continue;
          }
          result = await database.$transaction(tx => closeManagedPendingOrder(tx, candidate.id, "EXPIRED", now,
            undefined, { by: "system:expiry", reason: null }),
            { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
        } catch { result = failure("Expiration requires retry or review; no partial release was committed."); }
        results.push({ orderId: candidate.id, result });
      }
      return results;
    },
  };
}
