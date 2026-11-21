// Promotions & coupons service (FR-42, D-06 rules).
import { db } from "@/lib/db";
import type { Promotion } from "../../generated/postgres-client";
import type { CouponFormInput, PromotionFormInput } from "@/lib/validation";
import { validateCouponRecord, checkCouponUserEligibility, type ValidatedCoupon } from "@/lib/coupon-validation";
import { computeDiscount, type DiscountRule } from "@/lib/pricing";
import { ReservationWriteConflict } from "@/services/reservation-writes";

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** Minimal client surface the promotion engine needs — db or a transaction client. */
export interface PromotionReader {
  promotion: {
    findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
    }): Promise<Promotion[]>;
  };
}

export type { ValidatedCoupon } from "@/lib/coupon-validation";

/** Start must be strictly before end, when both are set (M-4). The same
 *  rule lives in the Zod schemas (route layer) and here (service layer,
 *  for direct callers); the route's schema is what returns 422s over HTTP. */
export function assertValidDateOrder(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  endLabel = "end date"
): void {
  if (!startsAt || !endsAt) return;
  if (new Date(startsAt) >= new Date(endsAt))
    throw new Error(`Start date must be before the ${endLabel}.`);
}

/** Validate a coupon code against subtotal + window/usage rules (server-side only).
 *  When userId is given, the per-user limit and first-order-only rule
 *  (D11/M-20) are enforced too; without it only the record-level rules run
 *  (the reservation itself always checks — see reserveCoupon). */
export async function validateCoupon(
  code: string,
  subtotal: number,
  userId?: string
): Promise<ValidatedCoupon | { error: string }> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { error: "Please enter a coupon code." };

  const coupon = await db.coupon.findUnique({ where: { code: normalized } });
  const validation = validateCouponRecord(coupon, subtotal);
  if ("error" in validation) return validation;
  if (userId) {
    const eligibility = await checkCouponUserEligibility(db, validation.coupon, userId);
    if (eligibility) return eligibility;
  }
  return validation;
}

/** Coupon lookup only — lets checkout quote fetch the coupon in parallel with
 *  settings/cart, then validate synchronously via validateCouponRecord. */
export async function findCouponByCode(code: string) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  return db.coupon.findUnique({ where: { code: normalized } });
}

export interface EvaluatedPromotion {
  promotion: Promotion;
  rule: DiscountRule;
  discountTotal: number;
}

/**
 * Automatic promotions engine (D10/M-19): promotions are real discounts,
 * not display-only. An applicable promotion is active, inside its date
 * window, and its minimum order amount is met.
 *
 * Precedence — exactly one discount source per order, never stacked:
 *  1. A coupon, when one is applied — no automatic promotion applies with it.
 *  2. Otherwise the single best applicable automatic promotion: the largest
 *     discount; ties break to the earliest-created promotion (stable).
 * Callers enforce (1) by only evaluating a promotion when no coupon was
 * applied; the order records which source won (couponCode XOR promotionId).
 */
export async function evaluateAutomaticPromotion(
  client: PromotionReader,
  subtotal: number,
  now = new Date()
): Promise<EvaluatedPromotion | null> {
  if (subtotal <= 0) return null;
  const rows = await client.promotion.findMany({
    where: {
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        { OR: [{ minOrderAmount: null }, { minOrderAmount: { lte: subtotal } }] },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let best: EvaluatedPromotion | null = null;
  for (const row of rows) {
    const rule: DiscountRule = { type: row.type as "PERCENT" | "FIXED", value: row.value, title: row.title };
    const discountTotal = computeDiscount(subtotal, rule);
    if (discountTotal <= 0) continue;
    if (!best || discountTotal > best.discountTotal) best = { promotion: row, rule, discountTotal };
  }
  return best;
}

/**
 * Reserve one coupon use in the checkout transaction. The usage-count
 * comparison is a compare-and-set, so concurrent checkouts cannot both claim
 * the same final use. The per-user limit (D11/M-20) is checked here too,
 * in-transaction, before the claim: the count is a pre-check only. The CAS
 * below guards TOTAL capacity (usedCount vs maxUses); the atomic per-user
 * guard is the partial unique index Order_userId_couponCode_active_idx on
 * the order insert (migration 20261120000006, P2002 — see
 * isPerUserCouponViolation). Two concurrent checkouts by the same user can
 * both pass the pre-check and both CAS-claim capacity; only the index stops
 * the second order from committing.
 * First-order-only has the same shape with a wider key (R-1): the count
 * cannot see across DIFFERENT first-order coupons, so the atomic guard is
 * the first-order claim — Order.firstOrderCoupon, set by the caller at
 * order.create from this coupon's firstOrderOnly flag, under the partial
 * unique index (migration 20261121000001). This function returns the
 * validated coupon (with firstOrderOnly) so the caller can set the flag;
 * the reservation itself does not claim it.
 */
export async function reserveCoupon(
  tx: TransactionClient,
  code: string,
  subtotal: number,
  userId: string
): Promise<ValidatedCoupon | { error: string }> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { error: "Please enter a coupon code." };

  const coupon = await tx.coupon.findUnique({ where: { code: normalized } });
  if (!coupon) return { error: "This coupon code is not valid." };
  const validation = validateCouponRecord(coupon, subtotal);
  if ("error" in validation) return validation;
  const eligibility = await checkCouponUserEligibility(tx, coupon, userId);
  if (eligibility) return eligibility;

  const now = new Date();
  const reserved = await tx.coupon.updateMany({
    where: {
      id: coupon.id,
      isActive: true,
      usedCount: coupon.usedCount,
      reservedCount: coupon.reservedCount,
      version: coupon.version,
      maxUses: coupon.maxUses,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
      ],
    },
    data: { usedCount: { increment: 1 }, version: { increment: 1 } },
  });
  if (reserved.count !== 1) {
    return { error: "This coupon has reached its usage limit." };
  }

  return validation;
}

export async function adminUpdateCoupon(id: string, d: CouponFormInput) {
  assertValidDateOrder(d.startsAt, d.expiresAt, "expiry date");
  return db.$transaction(async tx => {
    const coupon = await tx.coupon.findUniqueOrThrow({ where: { id } });
    if ((await tx.coupon.updateMany({ where: { id, version: coupon.version },
      data: { version: { increment: 1 } } })).count !== 1) throw new ReservationWriteConflict("Coupon changed. Refresh before editing.");
    if (coupon.reservedCount > 0 || await tx.couponReservation.count({ where: { couponId: id, state: "HELD" } }))
      throw new ReservationWriteConflict("This coupon has active payment reservations. Close those orders before editing it.");
    if (d.maxUses != null && d.maxUses < coupon.usedCount + coupon.reservedCount)
      throw new ReservationWriteConflict("The usage limit cannot be less than existing usage and reservations.");
    return tx.coupon.update({ where: { id }, data: {
      code: d.code, description: d.description || null, type: d.type, value: d.value,
      minOrderAmount: d.minOrderAmount, maxUses: d.maxUses ?? null, isActive: d.isActive,
      maxDiscountAmount: d.maxDiscountAmount ?? null, firstOrderOnly: d.firstOrderOnly ?? false,
      startsAt: d.startsAt ? new Date(d.startsAt) : null, expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
    } });
  });
}

/**
 * Admin promotion update with optimistic locking (Chunk 11, Low): the
 * caller claims the version it loaded (the admin manager sends it); a
 * stale form gets a 409 instead of silently overwriting a newer edit.
 * A direct caller that omits the version claims the version read here —
 * concurrent-write protection, but no stale-form detection. Mirrors
 * adminUpdateCoupon's claim pattern; promotions have no reservations, so
 * there is no held-capacity guard to check.
 */
export async function adminUpdatePromotion(id: string, d: PromotionFormInput) {
  assertValidDateOrder(d.startsAt, d.endsAt, "end date");
  return db.$transaction(async tx => {
    const promotion = await tx.promotion.findUniqueOrThrow({ where: { id } });
    const expectedVersion = d.version ?? promotion.version;
    if ((await tx.promotion.updateMany({ where: { id, version: expectedVersion },
      data: { version: { increment: 1 } } })).count !== 1)
      throw new ReservationWriteConflict("Promotion changed. Refresh before editing.");
    return tx.promotion.update({ where: { id }, data: {
      title: d.title, description: d.description || null, type: d.type, value: d.value,
      minOrderAmount: d.minOrderAmount ?? null, isActive: d.isActive,
      startsAt: d.startsAt ? new Date(d.startsAt) : null, endsAt: d.endsAt ? new Date(d.endsAt) : null,
    } });
  });
}

export async function adminDeleteCoupon(id: string) {
  return db.$transaction(async tx => {
    const coupon = await tx.coupon.findUniqueOrThrow({ where: { id } });
    if ((await tx.coupon.updateMany({ where: { id, version: coupon.version },
      data: { version: { increment: 1 } } })).count !== 1) throw new ReservationWriteConflict("Coupon changed. Refresh before deleting.");
    if (coupon.reservedCount > 0 || await tx.couponReservation.count({ where: { couponId: id } }))
      throw new ReservationWriteConflict("Payment reservation history must be preserved. Deactivate this coupon when no holds remain.");
    await tx.coupon.delete({ where: { id } });
  });
}

/** Active site-wide promotions for storefront display (FR-12). */
export async function getActivePromotions(limit = 3): Promise<Promotion[]> {
  const now = new Date();
  const rows = await db.promotion.findMany({
    where: {
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows;
}

/** Public shape for storefront promo strip. */
export function describePromotion(p: Promotion): string {
  if (p.type === "PERCENT") return `${p.value}% OFF`;
  return `Rs ${p.value.toLocaleString()} OFF`;
}
