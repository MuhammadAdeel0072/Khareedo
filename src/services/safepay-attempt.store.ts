import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Payment, Prisma, PrismaClient } from "../../generated/postgres-client";
import type { SafepayConfig } from "@/lib/safepay/config";
import { wholePkrToMinor, type CheckoutRequest, type Tracker } from "@/lib/safepay/contracts";

export type TrustedCheckoutOwner = { kind: "USER"; userId: string };
export type OwnerBinding = Readonly<{ kind: "USER"; hash: string; userId: string }>;
export type ClaimedAttempt = Readonly<{
  orderId: string; paymentId: string; keyHash: string; version: number;
  amountMinor: bigint; owner: OwnerBinding; deadlineMs: number;
}>;
export type ClaimResult = { kind: "claimed"; claim: ClaimedAttempt } |
  { kind: "blocked"; code: "NOT_ELIGIBLE" | "REQUEST_CONFLICT" | "CREATION_UNCERTAIN" |
    "ALREADY_ISSUED" | "RESUME_BLOCKED" | "BUSY" | "PERSISTENCE_UNAVAILABLE" };

export function bindCheckoutOwner(owner: TrustedCheckoutOwner): OwnerBinding {
  const principal = owner?.userId;
  if (owner?.kind !== "USER" || !principal || principal.length > 256 || /[\u0000-\u0020\u007f]/.test(principal)) {
    throw new Error("Invalid checkout owner.");
  }
  return Object.freeze({
    kind: "USER", userId: principal,
    hash: createHash("sha256").update(JSON.stringify(["KHAREEDO_CHECKOUT_OWNER_V1", owner.kind, principal])).digest("hex"),
  });
}

export function checkoutRequestIdentity(request: CheckoutRequest, owner: OwnerBinding): string {
  return createHash("sha256").update(JSON.stringify([
    "KHAREEDO_SAFEPAY_REQUEST_V1", owner.kind, owner.hash, request.orderId, request.paymentId, request.requestKey,
  ])).digest("hex");
}
function sameHash(a: string | null, b: string): boolean {
  return !!a && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const include = {
  items: { include: { inventoryReservation: { include: { inventory: true } } } },
  couponReservation: { include: { coupon: true } },
} as const;
type ReservedOrder = Prisma.OrderGetPayload<{ include: typeof include }>;
export type PaymentDatabase = Pick<PrismaClient, "$transaction">;

function eligible(order: ReservedOrder | null, payment: Payment | null, owner: OwnerBinding,
  config: SafepayConfig, now: Date): order is ReservedOrder {
  if (!order || !payment || payment.orderId !== order.id || order.paymentFlowVersion !== 1 ||
      order.paymentMethod !== "ONLINE" || order.status !== "PENDING" || order.paymentStatus !== "PENDING" ||
      payment.provider !== "SAFEPAY" || payment.status !== "PENDING" || !payment.attemptNumber ||
      order.acceptedPaymentId !== null || order.activePaymentId !== payment.id || order.paymentOwnerOrderId !== order.id ||
      order.checkoutClosedAt !== null || (order.paymentReviewStatus !== null && order.paymentReviewStatus !== "CLEAR") ||
      order.checkoutOwnerKind !== owner.kind || !sameHash(order.checkoutOwnerHash, owner.hash) ||
      order.userId !== owner.userId || order.isGuest ||
      !order.checkoutFingerprint || order.currency !== "PKR" || payment.currency !== "PKR" ||
      payment.providerEnvironment !== config.environment || payment.merchantAccountRef !== config.merchantAccountRef ||
      !order.reservationExpiresAt || order.reservationExpiresAt <= now ||
      !order.checkoutAccessExpiresAt || order.checkoutAccessExpiresAt <= now ||
      payment.amount !== order.total || (payment.capturedAmountMinor ?? BigInt(0)) !== BigInt(0) ||
      (payment.refundedAmountMinor ?? BigInt(0)) !== BigInt(0)) return false;
  try {
    if (payment.expectedAmountMinor !== wholePkrToMinor(order.total)) return false;
  } catch { return false; }
  if (!order.items.length || order.items.some(item =>
    !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.unitPrice < 0 ||
    !Number.isSafeInteger(item.unitPrice * item.quantity) || item.lineTotal !== item.unitPrice * item.quantity ||
    !item.productId || !item.inventoryReservation || item.inventoryReservation.state !== "HELD" ||
    item.inventoryReservation.quantity !== item.quantity ||
    item.inventoryReservation.inventory.productId !== item.productId)) return false;
  const subtotal = order.items.reduce((sum, item) => sum + item.lineTotal, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal !== order.subtotal ||
      [order.discountTotal, order.deliveryFee, order.giftWrapCharge, order.taxTotal].some(v => v < 0) ||
      order.discountTotal > subtotal ||
      order.total !== subtotal - order.discountTotal + order.deliveryFee + order.giftWrapCharge + order.taxTotal) return false;
  if (order.couponCode !== null) {
    if (!order.couponReservation || order.couponReservation.state !== "HELD" ||
        order.couponReservation.coupon.code !== order.couponCode ||
        order.couponReservation.coupon.reservedCount < 1) return false;
  } else if (order.couponReservation) return false;
  return true;
}

class ClaimConflict extends Error {}
function versionedOrderWhere(order: ReservedOrder, now: Date) {
  return { id: order.id, version: order.version, status: "PENDING", paymentStatus: "PENDING",
    paymentFlowVersion: 1, activePaymentId: order.activePaymentId, acceptedPaymentId: null,
    checkoutClosedAt: null, reservationExpiresAt: { gt: now }, checkoutAccessExpiresAt: { gt: now } };
}

// No client construction or application DB import. The future route must inject its server DB.
// No orders, reservations, coupon counters, payment settlement states or fulfilment states are created/changed here.
export function createPrismaSafepayStore(database: PaymentDatabase) {
  return {
    async claim(request: CheckoutRequest, owner: OwnerBinding, config: SafepayConfig, now: Date): Promise<ClaimResult> {
      try {
        return await database.$transaction(async tx => {
          const [order, payment] = await Promise.all([
            tx.order.findUnique({ where: { id: request.orderId }, include }),
            tx.payment.findUnique({ where: { id: request.paymentId } }),
          ]);
          if (!eligible(order, payment, owner, config, now) || !payment) return { kind: "blocked", code: "NOT_ELIGIBLE" };
          const keyHash = checkoutRequestIdentity(request, owner);
          if (payment.retryRequestKey !== null && payment.retryRequestKey !== keyHash) return { kind: "blocked", code: "REQUEST_CONFLICT" };
          if (payment.attemptState === "CHECKOUT_ISSUED") return { kind: "blocked", code: "ALREADY_ISSUED" };
          if (payment.attemptState === "CREATING" || payment.attemptState === "CREATION_UNCERTAIN") {
            return { kind: "blocked", code: "CREATION_UNCERTAIN" };
          }
          if (payment.creationStartedAt !== null) return { kind: "blocked", code: "RESUME_BLOCKED" };
          if (payment.trackerToken !== null || payment.attemptState !== "READY") return { kind: "blocked", code: "RESUME_BLOCKED" };
          // A changed active pointer does not prove an older hosted tracker is no longer payable.
          // Until provider finality/cancellation is confirmed, refuse replacement attempts too.
          if (await tx.payment.count({ where: {
            orderId: order.id, provider: "SAFEPAY", id: { not: payment.id },
            OR: [
              { creationStartedAt: { not: null } }, { trackerToken: { not: null } }, { reference: { not: null } },
              { attemptState: { in: ["CREATING", "CREATION_UNCERTAIN", "TRACKER_CREATED", "AUTHENTICATING", "CHECKOUT_ISSUED"] } },
            ],
          } }) > 0) return { kind: "blocked", code: "RESUME_BLOCKED" };
          if ((await tx.order.updateMany({ where: versionedOrderWhere(order, now), data: { version: { increment: 1 } } })).count !== 1) throw new ClaimConflict();
          if ((await tx.payment.updateMany({
            where: { id: payment.id, version: payment.version, attemptState: "READY", trackerToken: null, retryRequestKey: null },
            data: { retryRequestKey: keyHash, attemptState: "CREATING", creationStartedAt: now,
              reconcileStatus: "PENDING", version: { increment: 1 } },
          })).count !== 1) throw new ClaimConflict();
          await tx.paymentEvidence.create({ data: {
            paymentId: payment.id, source: "LOCAL", operation: "TRACKER_CREATE",
            validationStatus: "LOCAL_VALIDATED", decision: "REQUEST_CLAIMED",
            paymentVersion: payment.version + 1, orderVersion: order.version + 1,
          } });
          return { kind: "claimed", claim: {
            orderId: order.id, paymentId: payment.id, keyHash, version: payment.version + 1,
            amountMinor: payment.expectedAmountMinor!, owner,
            deadlineMs: Math.min(order.reservationExpiresAt!.getTime(), order.checkoutAccessExpiresAt!.getTime()),
          } };
        });
      } catch (error) {
        return { kind: "blocked", code: error instanceof ClaimConflict ||
          (typeof error === "object" && error !== null && "code" in error &&
            (error.code === "P2002" || error.code === "P2034")) ? "BUSY" : "PERSISTENCE_UNAVAILABLE" };
      }
    },
    async bindTracker(claim: ClaimedAttempt, tracker: Tracker, config: SafepayConfig, now: Date): Promise<ClaimedAttempt | null> {
      try {
        return await database.$transaction(async tx => {
          const identity = createHash("sha256").update(JSON.stringify([
            "SAFEPAY", config.environment, config.merchantAccountRef, tracker.token,
          ])).digest("hex");
          const changed = await tx.payment.updateMany({
            where: { id: claim.paymentId, orderId: claim.orderId, version: claim.version,
              retryRequestKey: claim.keyHash, attemptState: "CREATING", trackerToken: null },
            data: { trackerToken: tracker.token, trackerIdentityKey: identity, trackerBoundAt: now,
              providerState: tracker.state, providerStateObservedAt: now,
              attemptState: "TRACKER_CREATED", version: { increment: 1 } },
          });
          if (changed.count !== 1) throw new ClaimConflict();
          await tx.paymentEvidence.create({ data: {
            paymentId: claim.paymentId, source: "API", operation: "TRACKER_CREATE",
            validationStatus: "MATCHED", decision: "TRACKER_BOUND", observedProviderState: tracker.state,
            observedCurrency: tracker.currency, observedQuoteMinor: tracker.amountMinor, paymentVersion: claim.version + 1,
          } });
          return { ...claim, version: claim.version + 1 };
        });
      } catch { return null; }
    },
    async advance(claim: ClaimedAttempt, config: SafepayConfig, from: "TRACKER_CREATED" | "AUTHENTICATING",
      to: "AUTHENTICATING" | "CHECKOUT_ISSUED", now: Date): Promise<ClaimedAttempt | null> {
      if ((from === "TRACKER_CREATED" && to !== "AUTHENTICATING") ||
          (from === "AUTHENTICATING" && to !== "CHECKOUT_ISSUED")) return null;
      try {
        return await database.$transaction(async tx => {
          const [order, payment] = await Promise.all([
            tx.order.findUnique({ where: { id: claim.orderId }, include }),
            tx.payment.findUnique({ where: { id: claim.paymentId } }),
          ]);
          if (!eligible(order, payment, claim.owner, config, now) || !payment || payment.version !== claim.version ||
              !payment.trackerToken || payment.retryRequestKey !== claim.keyHash || payment.attemptState !== from) return null;
          if ((await tx.order.updateMany({ where: versionedOrderWhere(order, now), data: { version: { increment: 1 } } })).count !== 1) throw new ClaimConflict();
          if ((await tx.payment.updateMany({
            where: { id: payment.id, version: claim.version, retryRequestKey: claim.keyHash, attemptState: from },
            data: { attemptState: to, version: { increment: 1 } },
          })).count !== 1) throw new ClaimConflict();
          await tx.paymentEvidence.create({ data: {
            paymentId: payment.id, source: "LOCAL", operation: "HOSTED_CHECKOUT",
            validationStatus: "LOCAL_VALIDATED", decision: to, paymentVersion: claim.version + 1, orderVersion: order.version + 1,
          } });
          return { ...claim, version: claim.version + 1 };
        });
      } catch { return null; }
    },
  async review(
  claim: ClaimedAttempt,
  code: string,
  tracker?: Tracker,
  httpStatus?: number,
): Promise<void> {
      try {
        await database.$transaction(async tx => {
          // Settlement, expiry and admin processing lock Order before Payment.
          // A delayed session-setup error cannot downgrade a settled/closed order.
          const order = await tx.order.findUnique({ where: { id: claim.orderId } });
          if (!order || order.paymentFlowVersion !== 1 || order.status !== "PENDING" ||
              order.paymentStatus !== "PENDING" || order.acceptedPaymentId !== null || order.checkoutClosedAt) return;
          const payment = await tx.payment.findUnique({ where: { id: claim.paymentId } });
          if (!payment || payment.orderId !== order.id || payment.version !== claim.version ||
              payment.retryRequestKey !== claim.keyHash || !["CREATING", "TRACKER_CREATED", "AUTHENTICATING"].includes(payment.attemptState ?? "")) return;
          if ((await tx.order.updateMany({ where: { id: order.id, version: order.version, status: "PENDING",
            paymentStatus: "PENDING", acceptedPaymentId: null, checkoutClosedAt: null },
          data: { paymentReviewStatus: "REQUIRED", paymentReviewReason: code, version: { increment: 1 } } })).count !== 1)
            throw new ClaimConflict();
          const changed = await tx.payment.updateMany({
            where: { id: claim.paymentId, orderId: claim.orderId, version: claim.version, retryRequestKey: claim.keyHash,
              attemptState: { in: ["CREATING", "TRACKER_CREATED", "AUTHENTICATING"] } },
            data: { attemptState: "CREATION_UNCERTAIN", reconcileStatus: "REVIEW_REQUIRED",
              lastErrorCode: code, lastErrorAt: new Date(), version: { increment: 1 } },
          });
          if (changed.count !== 1) throw new ClaimConflict();
          await tx.paymentEvidence.create({ data: {
            paymentId: claim.paymentId, source: tracker ? "API" : "LOCAL", operation: "HOSTED_CHECKOUT",
            validationStatus: "UNVERIFIED", decision: "REVIEW_REQUIRED", reasonCode: code,
            paymentVersion: claim.version + 1, observedProviderState: tracker?.state,
            observedCurrency: tracker?.currency, observedQuoteMinor: tracker?.amountMinor,
           detailsJson: tracker || httpStatus !== undefined
  ? JSON.stringify({
      ...(tracker ? {
        unverifiedTrackerToken: tracker.token,
        environment: tracker.environment,
      } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    })
  : undefined,
          } });
        });
      } catch {
        // Durable CREATING/authentication claim remains non-retryable even if the DB is unavailable.
        // No raw persistence/provider exception is exposed or logged.
      }
    },
  };
}
export type SafepayAttemptStore = ReturnType<typeof createPrismaSafepayStore>;
