import type { Coupon } from "../../generated/postgres-client";
import type { DiscountRule } from "@/lib/pricing";

export interface ValidatedCoupon { rule: DiscountRule; coupon: Coupon }

/** Shared offline/hosted validation: held capacity cannot be sold a second time. */
export function validateCouponRecord(coupon: Coupon | null, subtotal: number, now = new Date()):
  ValidatedCoupon | { error: string } {
  if (!coupon || !coupon.isActive) return { error: "This coupon code is not valid." };
  if (coupon.startsAt && coupon.startsAt > now) return { error: "This coupon is not active yet." };
  if (coupon.expiresAt && coupon.expiresAt < now) return { error: "This coupon has expired." };
  if (coupon.maxUses !== null && coupon.usedCount + coupon.reservedCount >= coupon.maxUses)
    return { error: "This coupon has reached its usage limit." };
  if (subtotal < coupon.minOrderAmount)
    return { error: `This coupon requires a minimum order of Rs ${coupon.minOrderAmount.toLocaleString()}.` };
  return {
    rule: {
      type: coupon.type as "PERCENT" | "FIXED",
      value: coupon.value,
      title: coupon.code,
      // Per-coupon max-discount cap (D11/M-21): null = uncapped. Carried on
      // the rule so every pricing path clamps it (pricing.computeDiscount).
      maxDiscount: coupon.maxDiscountAmount ?? null,
    },
    coupon,
  };
}

/** Minimal client surface the per-user check needs — db or a transaction client. */
export interface OrderCounter {
  order: { count(args: { where: Record<string, unknown> }): Promise<number> };
}

/**
 * True when a Prisma P2002 names the one-redemption-per-user partial unique
 * index on Order (userId, couponCode) — migration 20261120000006, mirrored
 * in the SQLite harness. The index is raw SQL (Prisma cannot express
 * partial indexes), so the engine may not report a field target: match the
 * message too. `couponCode` is a column only on Order (Coupon uses `code`,
 * CouponReservation uses `couponId`), and no other unique constraint
 * involves it, so any P2002 mentioning it can only be this index.
 * Callers map it to COUPON_UNAVAILABLE instead of a generic duplicate.
 */
export function isPerUserCouponViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if ((error as { code?: unknown }).code !== "P2002") return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target) && target.includes("couponCode")) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("couponCode");
}

/**
 * True when a Prisma P2002 names the first-order claim partial unique
 * index on Order (userId) — migration 20261121000001, mirrored in the
 * SQLite harness. The index is raw SQL (Prisma cannot express partial
 * indexes), so the engine may not report a field target: match the
 * message too. `userId` is a column only on Order here (no other unique
 * constraint on the order row involves it except the per-user coupon
 * index, which always names couponCode as well), so a P2002 mentioning
 * userId without couponCode can only be this index. Callers map it to
 * COUPON_UNAVAILABLE with the existing first-order error instead of a
 * generic duplicate — the order is rejected, the coupon is not silently
 * dropped, and the order is not placed without it.
 */
export function isFirstOrderClaimViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if ((error as { code?: unknown }).code !== "P2002") return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.includes("Order_userId_first_order_coupon_active_idx")) return true;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target) && target.includes("userId") && !target.includes("couponCode")) return true;
  // Prisma renders the violation as "Unique constraint failed on the
  // fields: (`userId`)" for this index; the per-user index always names
  // couponCode alongside userId, so its presence excludes this claim.
  return typeof message === "string" && message.includes("userId") && !message.includes("couponCode");
}

/**
 * Per-user redemption limit (D11/M-20) + first-order-only (D11).
 *
 * The redemption IS a non-cancelled order carrying this coupon code. That
 * is deliberate: Chunk 2-final proved a COMMITTED CouponReservation row can
 * NEVER become RELEASED (CouponReservation_state_check permits RELEASED
 * only from HELD), so keying the check on a reservation row would count
 * paid-cancelled orders as active uses forever. Orders, by contrast, are
 * CANCELLED by every cancel path (admin, customer, paid-managed, pending
 * close, review release), so cancelling frees the redemption — including
 * orders placed before this chunk (no backfill needed).
 *
 * Concurrency: the count is a pre-check only. The usedCount/reservedCount
 * CAS guards total capacity (maxUses), NOT per-user uniqueness — two bare
 * reservations for one user both succeed. The atomic per-user guard is the
 * partial unique index on Order (userId, couponCode) excluding CANCELLED
 * rows (migration 20261120000006): a racing second order fails with P2002,
 * which callers detect with isPerUserCouponViolation and report as
 * COUPON_UNAVAILABLE. Under Serializable (Safepay) a race may surface as
 * P2034 instead, and the retry re-reads the count.
 *
 * First-order-only has the same shape with a wider key (R-1): the
 * per-user index cannot see across DIFFERENT first-order coupons, so
 * the atomic guard is the first-order claim — Order.firstOrderCoupon
 * (set at order creation from Coupon.firstOrderOnly) under the partial
 * unique index on Order (userId) excluding CANCELLED rows (migration
 * 20261121000001). A racing second first order fails its order.create
 * with P2002, which callers detect with isFirstOrderClaimViolation.
 * Serializable alone is NOT the fix (COD runs at Read Committed, and
 * P2034 aborts under normal concurrency are probabilistic, not a
 * deterministic guard).
 */
export async function checkCouponUserEligibility(
  client: OrderCounter,
  coupon: Coupon,
  userId: string,
): Promise<{ error: string } | null> {
  // The two counts are independent reads: run them concurrently (S9).
  // The second count is only needed for first-order-only coupons; when the
  // coupon is not first-order-only it resolves immediately with no query,
  // so the non-first-order path still issues exactly one count.
  const [priorRedemptions, priorOrders] = await Promise.all([
    client.order.count({
      where: { userId, couponCode: coupon.code, status: { not: "CANCELLED" } },
    }),
    coupon.firstOrderOnly
      ? client.order.count({ where: { userId, status: { not: "CANCELLED" } } })
      : Promise.resolve(0),
  ]);
  if (priorRedemptions > 0) return { error: "You have already used this coupon." };
  if (coupon.firstOrderOnly) {
    if (priorOrders > 0) return { error: "This coupon is only valid for your first order." };
  }
  return null;
}
