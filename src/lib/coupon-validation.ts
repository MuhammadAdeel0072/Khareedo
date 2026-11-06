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
  return { rule: { type: coupon.type as "PERCENT" | "FIXED", value: coupon.value, title: coupon.code }, coupon };
}
