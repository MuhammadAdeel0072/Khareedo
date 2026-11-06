import "server-only";
import type { Order, Prisma } from "../../generated/postgres-client";
import type { db } from "@/lib/db";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@/lib/constants";
import { wholePkrToMinor } from "@/lib/safepay/contracts";
import { bindCheckoutOwner, type OwnerBinding, type PaymentDatabase, type TrustedCheckoutOwner } from "@/services/safepay-attempt.store";

export type ReservationCloseResult = { ok: true; outcome: "RELEASED" | "REVIEW_REQUIRED" | "ALREADY_CLOSED" } |
  { ok: false; error: string };
export class ReservationIntegrityError extends Error {}
const failure = (error: string): ReservationCloseResult => ({ ok: false, error });

/** Locks the same Order row as the provider's durable creation claim. Never guesses provider finality. */
export async function closeManagedPendingOrder(tx: Prisma.TransactionClient, orderId: string,
  reason: "CANCELLED" | "EXPIRED", now: Date, owner?: OwnerBinding): Promise<ReservationCloseResult> {
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
  } });
  for (const payment of payments) {
    if ((await tx.payment.updateMany({ where: { id: payment.id, version: payment.version }, data: {
      ...(!mayBePayable ? { attemptState: "CLOSED" } : {}),
      reconcileStatus: mayBePayable ? "REVIEW_REQUIRED" : "NOT_REQUIRED", version: { increment: 1 },
    } })).count !== 1) throw new ReservationIntegrityError("Payment attempt changed during closure.");
    await tx.paymentEvidence.create({ data: { paymentId: payment.id, source: "LOCAL", operation: "CLOSE_CHECKOUT",
      validationStatus: "LOCAL_VALIDATED", decision: mayBePayable ? "HOLDS_RETAINED_FOR_REVIEW" : "RESERVATIONS_RELEASED",
      reasonCode: reason, paymentVersion: payment.version + 1, orderVersion: order.version + 1,
    } });
  }
  // Financial PENDING remains PENDING: local cancellation is not a provider failure/refund.
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

/** Admin-only caller supplies its authorized transaction. Never performs settlement. */
export async function updateManagedOrderStatus(transaction: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  orderId: string, next: OrderStatus, now: Date) {
  // The application adds query timing through $extends. It preserves native delegates
  // at runtime but Prisma's generated extension generics are not structurally assignable.
  const tx = transaction as unknown as Prisma.TransactionClient;
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || !ORDER_STATUS_TRANSITIONS[order.status as OrderStatus]?.includes(next))
    return { ok: false, error: "Cannot apply this order status transition." };
  if (next === "CANCELLED") return closeManagedPendingOrder(tx, orderId, "CANCELLED", now);
  if (!await canFulfilManagedOrder(tx, order)) return { ok: false, error: "Verified payment and consumed reservations are required before fulfilment." };
  const changed = await tx.order.updateMany({ where: { id: order.id, version: order.version, status: order.status,
    paymentStatus: "PAID", acceptedPaymentId: order.acceptedPaymentId, checkoutClosedAt: null, paymentReviewStatus: "CLEAR" },
  data: { status: next, version: { increment: 1 } } });
  return changed.count === 1 ? { ok: true } : { ok: false, error: "The order changed. Please retry." };
}

export function createSafepayReservationService(database: PaymentDatabase, clock = () => new Date()) {
  return {
    async cancel(orderId: string, principal: TrustedCheckoutOwner): Promise<ReservationCloseResult> {
      try {
        const owner = bindCheckoutOwner(principal);
        return await database.$transaction(tx => closeManagedPendingOrder(tx, orderId, "CANCELLED", clock(), owner),
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
          result = await database.$transaction(tx => closeManagedPendingOrder(tx, candidate.id, "EXPIRED", now),
            { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
        } catch { result = failure("Expiration requires retry or review; no partial release was committed."); }
        results.push({ orderId: candidate.id, result });
      }
      return results;
    },
  };
}
