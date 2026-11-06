// Promotions & coupons service (FR-42, D-06 rules).
import { db } from "@/lib/db";
import type { Promotion } from "../../generated/postgres-client";
import type { CouponFormInput } from "@/lib/validation";
import { validateCouponRecord, type ValidatedCoupon } from "@/lib/coupon-validation";
import { ReservationWriteConflict } from "@/services/reservation-writes";

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export type { ValidatedCoupon } from "@/lib/coupon-validation";

/** Validate a coupon code against subtotal + window/usage rules (server-side only). */
export async function validateCoupon(
  code: string,
  subtotal: number
): Promise<ValidatedCoupon | { error: string }> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { error: "Please enter a coupon code." };

  const coupon = await db.coupon.findUnique({ where: { code: normalized } });
  return validateCouponRecord(coupon, subtotal);
}

/**
 * Reserve one coupon use in the checkout transaction. The usage-count
 * comparison is a compare-and-set, so concurrent checkouts cannot both claim
 * the same final use.
 */
export async function reserveCoupon(
  tx: TransactionClient,
  code: string,
  subtotal: number
): Promise<ValidatedCoupon | { error: string }> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { error: "Please enter a coupon code." };

  const coupon = await tx.coupon.findUnique({ where: { code: normalized } });
  if (!coupon) return { error: "This coupon code is not valid." };
  const validation = validateCouponRecord(coupon, subtotal);
  if ("error" in validation) return validation;

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
      startsAt: d.startsAt ? new Date(d.startsAt) : null, expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
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
