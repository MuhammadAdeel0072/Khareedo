// Promotions & coupons service (FR-42, D-06 rules).
import { db } from "@/lib/db";
import type { DiscountRule } from "@/lib/pricing";
import type { Prisma, Coupon, Promotion } from "../../generated/postgres-client";

export interface ValidatedCoupon {
  rule: DiscountRule;
  coupon: Coupon;
}

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
  tx: Prisma.TransactionClient,
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
      maxUses: coupon.maxUses,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
      ],
    },
    data: { usedCount: { increment: 1 } },
  });
  if (reserved.count !== 1) {
    return { error: "This coupon has reached its usage limit." };
  }

  return validation;
}

function validateCouponRecord(
  coupon: Coupon | null,
  subtotal: number
): ValidatedCoupon | { error: string } {
  if (!coupon || !coupon.isActive) return { error: "This coupon code is not valid." };

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now)
    return { error: "This coupon is not active yet." };
  if (coupon.expiresAt && coupon.expiresAt < now)
    return { error: "This coupon has expired." };
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses)
    return { error: "This coupon has reached its usage limit." };
  if (subtotal < coupon.minOrderAmount)
    return {
      error: `This coupon requires a minimum order of Rs ${coupon.minOrderAmount.toLocaleString()}.`,
    };

  return {
    rule: { type: coupon.type as "PERCENT" | "FIXED", value: coupon.value, title: coupon.code },
    coupon,
  };
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
