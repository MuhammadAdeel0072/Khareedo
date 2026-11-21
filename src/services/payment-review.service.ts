// Admin payment-review resolution (Phase 3, H-13 / H-16).
//
// Managed orders whose checkout closed while a payment may have been payable
// keep their coupon + inventory reservations HELD and sit at
// paymentReviewStatus "REQUIRED" until a human resolves them. Nothing in the
// automated pipeline ever releases or consumes those holds — that is the H-13
// defect. This service is the single resolution path. The provider outcome
// must already be verified before resolution: the maintenance "investigate"
// action consults Safepay and records RECONCILIATION evidence. Resolution
// then takes one of two explicit outcomes:
//
//   NOT_CAPTURED — the provider never took the money: release the coupon and
//                  inventory reservations, close the payment attempts, clear
//                  the review flag. The order stays CANCELLED.
//   CAPTURED     — the provider did take the money (capture evidence for the
//                  full expected amount): consume the reservations and accept
//                  the payment as PAID. The order stays CANCELLED — the
//                  managed flow is closed for it, so the admin must handle
//                  the money (refund or manual resolution) next.
//
// Both branches run as one Serializable transaction with compare-and-set
// claims, so a repeated resolution is a no-op (NOT_ELIGIBLE) and concurrent
// resolutions cannot double-release or double-consume. The service never
// invents provider finality: without post-closure investigation evidence it
// refuses, and any capture evidence blocks a release.
import "server-only";
import { db } from "@/lib/db";
import { wholePkrToMinor } from "@/lib/safepay/contracts";
import {
  ADMIN_AUDIT_ACTIONS,
  recordAdminAudit,
  type AdminAuditContext,
} from "@/services/admin-audit.service";
import type { Prisma, PrismaClient } from "../../generated/postgres-client";

type ReviewDatabase = Pick<
  PrismaClient,
  "$transaction" | "order" | "payment" | "paymentEvidence"
>;

class ReservationMismatchError extends Error {}

export type ReviewHoldOutcome = "NOT_CAPTURED" | "CAPTURED";

export type ResolvePaymentReviewHoldResult =
  | { ok: true; outcome: "RELEASED" | "CONSUMED"; paymentId?: string }
  | {
      ok: false;
      code:
        | "NOT_ELIGIBLE"
        // Stage 3 audit, L-3: a resolve against a nonexistent order is
        // ORDER_NOT_FOUND (→ 404 at the route), not NOT_ELIGIBLE (→ 409)
        // — the admin UI must be able to tell "no such order" from a
        // genuinely ineligible hold.
        | "ORDER_NOT_FOUND"
        | "INVESTIGATION_REQUIRED"
        | "CAPTURE_EVIDENCE_PRESENT"
        | "CAPTURE_EVIDENCE_REQUIRED"
        | "CAPTURE_AMOUNT_MISMATCH"
        | "RESERVATION_MISMATCH"
        | "ORDER_CHANGED";
    };

export type PaymentReviewCase = {
  orderId: string;
  reference: string;
  orderStatus: string;
  paymentStatus: string;
  reviewReason: string | null;
  closeReason: string | null;
  closedAt: string | null;
  reservationExpiresAt: string | null;
  /** Provider was consulted about this closed order after closure. */
  investigated: boolean;
  /** Provider evidence shows money was captured for this order. */
  captureEvidence: boolean;
};

/** Review queue, shared by the API route and the admin page (single source of truth). */
export async function countPaymentReviewCases(
  database?: ReviewDatabase
): Promise<number> {
  // Same WHERE as listPaymentReviewCases (no cap): the ops-health count on
  // the dashboard must agree with the queue itself, not stop at 25.
  const reviewDb = database ?? (db as unknown as ReviewDatabase);
  return reviewDb.order.count({
    where: { paymentFlowVersion: 1, paymentReviewStatus: "REQUIRED" },
  });
}

export async function listPaymentReviewCases(
  database?: ReviewDatabase
): Promise<PaymentReviewCase[]> {
  const reviewDb = database ?? (db as unknown as ReviewDatabase);
  const orders = await reviewDb.order.findMany({
    where: { paymentFlowVersion: 1, paymentReviewStatus: "REQUIRED" },
    select: {
      id: true,
      reference: true,
      status: true,
      paymentStatus: true,
      paymentReviewReason: true,
      checkoutCloseReason: true,
      checkoutClosedAt: true,
      reservationExpiresAt: true,
    },
    orderBy: [{ checkoutClosedAt: "asc" }, { id: "asc" }],
    take: 25,
  });
  if (orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);
  const payments = await reviewDb.payment.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true },
  });
  const paymentOrder = new Map(payments.map((p) => [p.id, p.orderId]));
  const evidence = await reviewDb.paymentEvidence.findMany({
    where: { paymentId: { in: payments.map((p) => p.id) } },
    select: {
      paymentId: true,
      source: true,
      recordedAt: true,
      observedCapturedMinor: true,
    },
  });
  const byOrder = new Map<string, { investigated: boolean; capture: boolean }>();
  for (const order of orders) byOrder.set(order.id, { investigated: false, capture: false });
  for (const row of evidence) {
    const orderId = paymentOrder.get(row.paymentId);
    if (!orderId) continue;
    const flags = byOrder.get(orderId)!;
    const order = orders.find((o) => o.id === orderId)!;
    if (
      row.source === "RECONCILIATION" &&
      (!order.checkoutClosedAt || row.recordedAt >= order.checkoutClosedAt)
    ) {
      flags.investigated = true;
    }
    if (row.observedCapturedMinor !== null && row.observedCapturedMinor > BigInt(0)) {
      flags.capture = true;
    }
  }
  return orders.map((order) => ({
    orderId: order.id,
    reference: order.reference,
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
    reviewReason: order.paymentReviewReason,
    closeReason: order.checkoutCloseReason,
    closedAt: order.checkoutClosedAt?.toISOString() ?? null,
    reservationExpiresAt: order.reservationExpiresAt?.toISOString() ?? null,
    investigated: byOrder.get(order.id)!.investigated,
    captureEvidence: byOrder.get(order.id)!.capture,
  }));
}

export function createPaymentReviewService(
  database?: ReviewDatabase,
  clock: () => Date = () => new Date()
) {
  const reviewDb = database ?? (db as unknown as ReviewDatabase);

  return {
    /**
     * Resolve a REQUIRED payment-review hold after the provider outcome was
     * verified (see the module comment). Returns a refusal code instead of
     * throwing for every expected ineligible state; only persistence failures
     * throw.
     */
    async resolvePaymentReviewHold(
      orderId: string,
      outcome: ReviewHoldOutcome,
      audit?: AdminAuditContext
    ): Promise<ResolvePaymentReviewHoldResult> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
        return { ok: false, code: "NOT_ELIGIBLE" };
      }
      const now = clock();
      try {
        return await reviewDb.$transaction(
          async (tx) => {
            const order = await tx.order.findUnique({
              where: { id: orderId },
              include: {
                payments: { orderBy: { attemptNumber: "asc" } },
                items: {
                  orderBy: { productId: "asc" },
                  include: {
                    inventoryReservation: { include: { inventory: true } },
                  },
                },
                couponReservation: { include: { coupon: true } },
              },
            });
            if (
              !order ||
              order.paymentFlowVersion !== 1 ||
              order.paymentMethod !== "ONLINE" ||
              order.status !== "CANCELLED" ||
              order.paymentStatus !== "PENDING" ||
              order.acceptedPaymentId !== null ||
              !order.checkoutClosedAt ||
              order.paymentReviewStatus !== "REQUIRED"
            ) {
              // Stage 3 audit, L-3: a missing order is its own code so
              // the route can answer 404 instead of 409 NOT_ELIGIBLE.
              if (!order) return { ok: false, code: "ORDER_NOT_FOUND" } as const;
              return { ok: false, code: "NOT_ELIGIBLE" } as const;
            }
            const payments = order.payments;
            if (payments.length === 0) {
              return { ok: false, code: "NOT_ELIGIBLE" } as const;
            }

            const paymentIds = payments.map((p) => p.id);
            const evidence = await tx.paymentEvidence.findMany({
              where: { paymentId: { in: paymentIds } },
              orderBy: { recordedAt: "desc" },
            });
            const closedAt = order.checkoutClosedAt;
            const reconciliationEvidence = evidence.filter(
              (e) => e.source === "RECONCILIATION" && e.recordedAt >= closedAt
            );
            const captureEvidence = evidence.filter(
              (e) =>
                e.observedCapturedMinor !== null &&
                e.observedCapturedMinor > BigInt(0)
            );
            const allAttemptsNotStarted = payments.every(
              (p) =>
                !p.trackerToken &&
                !p.creationStartedAt &&
                !p.reference &&
                !p.retryRequestKey &&
                p.attemptState === "READY"
            );
            const paymentsClean = payments.every(
              (p) =>
                p.status === "PENDING" &&
                (p.capturedAmountMinor ?? BigInt(0)) === BigInt(0) &&
                (p.refundedAmountMinor ?? BigInt(0)) === BigInt(0) &&
                p.paidVerifiedAt === null
            );

            let capturedPayment: (typeof payments)[number] | null = null;
            let expectedMinor: bigint | null = null;
            if (outcome === "CAPTURED") {
              if (captureEvidence.length === 0) {
                return { ok: false, code: "CAPTURE_EVIDENCE_REQUIRED" } as const;
              }
              const capturedIds = new Set(
                captureEvidence.map((e) => e.paymentId)
              );
              if (capturedIds.size !== 1) {
                return { ok: false, code: "CAPTURE_AMOUNT_MISMATCH" } as const;
              }
              capturedPayment =
                payments.find((p) => p.id === [...capturedIds][0]) ?? null;
              if (!capturedPayment) {
                return { ok: false, code: "CAPTURE_EVIDENCE_REQUIRED" } as const;
              }
              expectedMinor =
                capturedPayment.expectedAmountMinor ??
                wholePkrToMinor(order.total);
              const matching = captureEvidence.filter(
                (e) =>
                  e.paymentId === capturedPayment!.id &&
                  e.observedCapturedMinor === expectedMinor
              );
              if (matching.length === 0) {
                return { ok: false, code: "CAPTURE_AMOUNT_MISMATCH" } as const;
              }
              if (
                capturedPayment.status !== "PENDING" ||
                (capturedPayment.refundedAmountMinor ?? BigInt(0)) !==
                  BigInt(0) ||
                capturedPayment.paidVerifiedAt !== null
              ) {
                return { ok: false, code: "NOT_ELIGIBLE" } as const;
              }
            } else {
              if (!paymentsClean) {
                return { ok: false, code: "NOT_ELIGIBLE" } as const;
              }
              if (captureEvidence.length > 0) {
                return { ok: false, code: "CAPTURE_EVIDENCE_PRESENT" } as const;
              }
              if (
                reconciliationEvidence.length === 0 &&
                !allAttemptsNotStarted
              ) {
                return { ok: false, code: "INVESTIGATION_REQUIRED" } as const;
              }
            }

            // Reservation integrity, mirroring closeManagedPendingOrder's
            // lock order: coupon before inventory.
            const couponHold = order.couponReservation;
            if (!!order.couponCode !== !!couponHold) {
              throw new ReservationMismatchError(
                "Coupon code and coupon reservation disagree."
              );
            }
            if (order.items.length === 0) {
              throw new ReservationMismatchError("Order has no items.");
            }
            for (const item of order.items) {
              const hold = item.inventoryReservation;
              if (
                !hold ||
                hold.state !== "HELD" ||
                hold.quantity !== item.quantity ||
                hold.inventory.productId !== item.productId
              ) {
                throw new ReservationMismatchError(
                  "Inventory reservation mismatch."
                );
              }
            }
            if (couponHold && couponHold.state !== "HELD") {
              throw new ReservationMismatchError(
                "Coupon reservation is not HELD."
              );
            }

            // Claim the review exactly once: a repeat resolution finds the
            // flag already CLEAR and is refused as NOT_ELIGIBLE above.
            const claimed = await tx.order.updateMany({
              where: {
                id: order.id,
                version: order.version,
                status: "CANCELLED",
                paymentReviewStatus: "REQUIRED",
              },
              data: { version: { increment: 1 } },
            });
            if (claimed.count !== 1) {
              return { ok: false, code: "ORDER_CHANGED" } as const;
            }

            if (outcome === "NOT_CAPTURED") {
              // Release, mirroring closeManagedPendingOrder's release path.
              if (couponHold) {
                if (
                  (await tx.coupon.updateMany({
                    where: {
                      id: couponHold.couponId,
                      code: order.couponCode!,
                      reservedCount: { gte: 1 },
                    },
                    data: {
                      reservedCount: { decrement: 1 },
                      version: { increment: 1 },
                    },
                  })).count !== 1
                ) {
                  throw new ReservationMismatchError(
                    "Coupon reservation counter mismatch."
                  );
                }
                if (
                  (await tx.couponReservation.updateMany({
                    where: {
                      id: couponHold.id,
                      version: couponHold.version,
                      state: "HELD",
                    },
                    data: {
                      state: "RELEASED",
                      releasedAt: now,
                      releaseReason: "REVIEW_RELEASED_NOT_CAPTURED",
                      version: { increment: 1 },
                    },
                  })).count !== 1
                ) {
                  throw new ReservationMismatchError(
                    "Coupon reservation changed."
                  );
                }
              }
              for (const item of order.items) {
                const hold = item.inventoryReservation!;
                if (
                  (await tx.inventory.updateMany({
                    where: { id: hold.inventoryId },
                    data: {
                      quantity: { increment: hold.quantity },
                      version: { increment: 1 },
                    },
                  })).count !== 1
                ) {
                  throw new ReservationMismatchError(
                    "Inventory reservation could not be restored."
                  );
                }
                if (
                  (await tx.inventoryReservation.updateMany({
                    where: {
                      id: hold.id,
                      version: hold.version,
                      state: "HELD",
                    },
                    data: {
                      state: "RELEASED",
                      releasedAt: now,
                      releaseReason: "REVIEW_RELEASED_NOT_CAPTURED",
                      version: { increment: 1 },
                    },
                  })).count !== 1
                ) {
                  throw new ReservationMismatchError(
                    "Inventory reservation changed."
                  );
                }
              }
              for (const payment of payments) {
                if (
                  (await tx.payment.updateMany({
                    where: { id: payment.id, version: payment.version },
                    data: {
                      attemptState: "CLOSED",
                      reconcileStatus: "NOT_REQUIRED",
                      version: { increment: 1 },
                    },
                  })).count !== 1
                ) {
                  throw new ReservationMismatchError(
                    "Payment attempt changed during resolution."
                  );
                }
                await tx.paymentEvidence.create({
                  data: {
                    paymentId: payment.id,
                    source: "LOCAL",
                    operation: "REVIEW_HOLD_RELEASED",
                    validationStatus: "LOCAL_VALIDATED",
                    decision: "HOLDS_RELEASED",
                    reasonCode: "REVIEW_RELEASED_NOT_CAPTURED",
                    paymentVersion: payment.version + 1,
                    orderVersion: order.version + 1,
                  },
                });
              }
              await tx.order.update({
                where: { id: order.id },
                data: {
                  paymentReviewStatus: "CLEAR",
                  paymentReviewReason: null,
                  // Finality is now established — the review proved nothing
                  // was captured — so the unpaid payment is CANCELLED (D2/M-7),
                  // not left PENDING forever on an already-cancelled order.
                  paymentStatus: "CANCELLED",
                },
              });
              await tx.payment.updateMany({
                where: { orderId: order.id, status: "PENDING" },
                data: { status: "CANCELLED" },
              });
              if (audit) {
                await recordAdminAudit(
                  audit,
                  {
                    action:
                      ADMIN_AUDIT_ACTIONS.PAYMENT_REVIEW_HOLD_RESOLVED,
                    targetType: "Order",
                    targetId: order.id,
                    metadata: {
                      outcome: "NOT_CAPTURED",
                      reference: order.reference,
                      closeReason: order.checkoutCloseReason,
                    },
                  },
                  tx
                );
              }
              return { ok: true, outcome: "RELEASED" } as const;
            }

            // Consume, mirroring the settlement capture path: coupon first.
            const captured = capturedPayment!;
            if (couponHold) {
              const coupon = couponHold.coupon;
              if (
                (await tx.coupon.updateMany({
                  where: {
                    id: coupon.id,
                    version: coupon.version,
                    code: order.couponCode!,
                    reservedCount: { gte: 1 },
                    usedCount: coupon.usedCount,
                  },
                  data: {
                    reservedCount: { decrement: 1 },
                    usedCount: { increment: 1 },
                    version: { increment: 1 },
                  },
                })).count !== 1
              ) {
                throw new ReservationMismatchError(
                  "Coupon reservation counter mismatch."
                );
              }
              if (
                (await tx.couponReservation.updateMany({
                  where: {
                    id: couponHold.id,
                    version: couponHold.version,
                    state: "HELD",
                  },
                  data: {
                    state: "COMMITTED",
                    committedAt: now,
                    version: { increment: 1 },
                  },
                })).count !== 1
              ) {
                throw new ReservationMismatchError(
                  "Coupon reservation changed."
                );
              }
            }
            for (const item of order.items) {
              const hold = item.inventoryReservation!;
              if (
                (await tx.inventoryReservation.updateMany({
                  where: { id: hold.id, version: hold.version, state: "HELD" },
                  data: {
                    state: "CONSUMED",
                    consumedAt: now,
                    version: { increment: 1 },
                  },
                })).count !== 1
              ) {
                throw new ReservationMismatchError(
                  "Inventory reservation changed."
                );
              }
              // Inventory.quantity was already reduced when HELD: deliberately
              // no stock write here.
            }
            for (const payment of payments) {
              if (payment.id === captured.id) {
                if (
                  (await tx.payment.updateMany({
                    where: { id: payment.id, version: payment.version },
                    data: {
                      status: "PAID",
                      attemptState: "SETTLED",
                      capturedAmountMinor: expectedMinor!,
                      paidVerifiedAt: now,
                      reconcileStatus: "VERIFIED",
                      version: { increment: 1 },
                    },
                  })).count !== 1
                ) {
                  throw new ReservationMismatchError(
                    "Payment attempt changed during resolution."
                  );
                }
              } else if (
                (await tx.payment.updateMany({
                  where: { id: payment.id, version: payment.version },
                  data: {
                    attemptState: "CLOSED",
                    reconcileStatus: "NOT_REQUIRED",
                    version: { increment: 1 },
                  },
                })).count !== 1
              ) {
                throw new ReservationMismatchError(
                  "Payment attempt changed during resolution."
                );
              }
              await tx.paymentEvidence.create({
                data: {
                  paymentId: payment.id,
                  source: "LOCAL",
                  operation: "REVIEW_HOLD_CONSUMED",
                  validationStatus: "LOCAL_VALIDATED",
                  decision: "PAYMENT_ACCEPTED_AFTER_REVIEW",
                  reasonCode: "REVIEW_CONSUMED_CAPTURED",
                  observedCapturedMinor:
                    payment.id === captured.id ? expectedMinor! : null,
                  paymentVersion: payment.version + 1,
                  orderVersion: order.version + 1,
                },
              });
            }
            await tx.order.update({
              where: { id: order.id },
              data: {
                paymentStatus: "PAID",
                acceptedPaymentId: captured.id,
                paymentOwnerOrderId: order.id,
                paymentReviewStatus: "CLEAR",
                paymentReviewReason: null,
              },
            });
            if (audit) {
              await recordAdminAudit(
                audit,
                {
                  action: ADMIN_AUDIT_ACTIONS.PAYMENT_REVIEW_HOLD_RESOLVED,
                  targetType: "Order",
                  targetId: order.id,
                  metadata: {
                    outcome: "CAPTURED",
                    reference: order.reference,
                    closeReason: order.checkoutCloseReason,
                    paymentId: captured.id,
                  },
                },
                tx
              );
            }
            return {
              ok: true,
              outcome: "CONSUMED",
              paymentId: captured.id,
            } as const;
          },
          { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 }
        );
      } catch (error) {
        if (error instanceof ReservationMismatchError) {
          return { ok: false, code: "RESERVATION_MISMATCH" };
        }
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code: unknown }).code
            : null;
        if (code === "P2034") return { ok: false, code: "ORDER_CHANGED" };
        throw error;
      }
    },
  };
}

export type PaymentReviewService = ReturnType<
  typeof createPaymentReviewService
>;
