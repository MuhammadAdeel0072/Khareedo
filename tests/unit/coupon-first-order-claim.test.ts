// Unit tests — first-order claim P2002 matcher (R-1, migration 20261121000001).
// No database: the matcher only inspects the Prisma error shape.
import { describe, expect, it } from "vitest";
import {
  isFirstOrderClaimViolation,
  isPerUserCouponViolation,
} from "@/lib/coupon-validation";

const p2002 = (over: Record<string, unknown> = {}) => ({
  code: "P2002",
  message: "Unique constraint failed on the fields: (`userId`)",
  meta: { target: ["userId"] },
  ...over,
});

describe("isFirstOrderClaimViolation", () => {
  it("matches a P2002 naming the claim index", () => {
    expect(
      isFirstOrderClaimViolation(
        p2002({
          message:
            'Unique constraint failed on the constraint: "Order_userId_first_order_coupon_active_idx"',
          meta: { target: "Order_userId_first_order_coupon_active_idx" },
        }),
      ),
    ).toBe(true);
  });

  it("matches a P2002 whose target is userId alone", () => {
    expect(isFirstOrderClaimViolation(p2002())).toBe(true);
  });

  it("matches a P2002 whose message names userId without couponCode", () => {
    expect(
      isFirstOrderClaimViolation(
        p2002({ meta: undefined, message: "Unique constraint failed on the fields: (`userId`)" }),
      ),
    ).toBe(true);
  });

  it("does NOT match the per-user coupon violation (same user, same coupon)", () => {
    const perUser = p2002({
      message: "Unique constraint failed on the fields: (`userId`, `couponCode`)",
      meta: { target: ["userId", "couponCode"] },
    });
    expect(isFirstOrderClaimViolation(perUser)).toBe(false);
    expect(isPerUserCouponViolation(perUser)).toBe(true);
  });

  it("does NOT match the per-user violation named by its index", () => {
    expect(
      isFirstOrderClaimViolation(
        p2002({
          message:
            'Unique constraint failed on the constraint: "Order_userId_couponCode_active_idx"',
          meta: { target: "Order_userId_couponCode_active_idx" },
        }),
      ),
    ).toBe(false);
  });

  it("does NOT match an idempotency-key duplicate", () => {
    expect(
      isFirstOrderClaimViolation(
        p2002({
          message: "Unique constraint failed on the fields: (`idempotencyKey`)",
          meta: { target: ["idempotencyKey"] },
        }),
      ),
    ).toBe(false);
  });

  it("does NOT match P2034, non-P2002 codes, or non-objects", () => {
    expect(isFirstOrderClaimViolation({ code: "P2034", message: "userId" })).toBe(false);
    expect(isFirstOrderClaimViolation({ code: "P2025", message: "userId" })).toBe(false);
    expect(isFirstOrderClaimViolation(null)).toBe(false);
    expect(isFirstOrderClaimViolation("P2002")).toBe(false);
    expect(isFirstOrderClaimViolation(undefined)).toBe(false);
  });
});
