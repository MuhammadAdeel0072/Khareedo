// Unit tests — pricing engine (FR-21, FR-30, BR-04/06/12/15).
import { describe, expect, it } from "vitest";
import {
  computeLines,
  computeDiscount,
  computeDeliveryFee,
  computeGiftWrapCharge,
  computeOrderPricing,
  discountPercent,
} from "@/lib/pricing";

const DELIVERY = { standardFee: 200, expressFee: 400, freeThreshold: 3000 };
const GIFT = { enabled: true, charge: 150 };

describe("computeLines — cart subtotal from current valid prices (FR-16, BR-04)", () => {
  it("computes line totals and subtotal", () => {
    const { lines, subtotal } = computeLines([
      { productId: "a", unitPrice: 5699, quantity: 1 },
      { productId: "b", unitPrice: 2499, quantity: 2 },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].lineTotal).toBe(5699);
    expect(lines[1].lineTotal).toBe(4998);
    expect(subtotal).toBe(10697);
  });

  it("clamps quantity to minimum 1 and ignores invalid prices", () => {
    const { lines, subtotal } = computeLines([
      { productId: "a", unitPrice: 100, quantity: 0 },
      { productId: "b", unitPrice: Number.NaN, quantity: 2 },
    ]);
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].lineTotal).toBe(100);
    expect(lines[1].lineTotal).toBe(0); // NaN price → 0, never corrupt totals
    expect(subtotal).toBe(100);
  });
});

describe("computeDiscount — coupons/promotions (D-06, FR-21)", () => {
  it("percent discount floors to whole rupees", () => {
    expect(computeDiscount(17497, { type: "PERCENT", value: 12 })).toBe(2099); // 2099.64 → 2099
    expect(computeDiscount(1000, { type: "PERCENT", value: 10 })).toBe(100);
  });

  it("percent caps at 100", () => {
    expect(computeDiscount(1000, { type: "PERCENT", value: 150 })).toBe(1000);
  });

  it("fixed discount never exceeds subtotal", () => {
    expect(computeDiscount(300, { type: "FIXED", value: 500 })).toBe(300);
    expect(computeDiscount(5000, { type: "FIXED", value: 500 })).toBe(500);
  });

  it("returns 0 for null rule", () => {
    expect(computeDiscount(1000, null)).toBe(0);
  });
});

describe("computeDeliveryFee — configurable flat fees (D-03)", () => {
  it("charges standard fee below threshold", () => {
    expect(computeDeliveryFee(2000, "STANDARD", DELIVERY)).toBe(200);
  });

  it("standard delivery is free at/above threshold", () => {
    expect(computeDeliveryFee(3000, "STANDARD", DELIVERY)).toBe(0);
    expect(computeDeliveryFee(12000, "STANDARD", DELIVERY)).toBe(0);
  });

  it("express always charges", () => {
    expect(computeDeliveryFee(12000, "EXPRESS", DELIVERY)).toBe(400);
  });
});

describe("computeGiftWrapCharge — charged per wrapped item unit (FR-30, FR-31, BR-12)", () => {
  it("charges per wrapped unit so mixed carts wrap exactly the chosen products", () => {
    expect(computeGiftWrapCharge(0, GIFT)).toBe(0);
    expect(computeGiftWrapCharge(1, GIFT)).toBe(150);
    expect(computeGiftWrapCharge(2, GIFT)).toBe(300);
    expect(computeGiftWrapCharge(3, { enabled: true, charge: 150 })).toBe(450);
  });

  it("does not apply when disabled or nothing is wrapped", () => {
    expect(computeGiftWrapCharge(0, GIFT)).toBe(0);
    expect(computeGiftWrapCharge(2, { enabled: false, charge: 150 })).toBe(0);
  });

  it("ignores invalid unit counts", () => {
    expect(computeGiftWrapCharge(Number.NaN, GIFT)).toBe(0);
    expect(computeGiftWrapCharge(-1, GIFT)).toBe(0);
  });
});

describe("computeOrderPricing — full pipeline (BR-06)", () => {
  it("total = subtotal − discount + delivery + giftWrap", () => {
    const result = computeOrderPricing({
      lines: [
        { productId: "a", unitPrice: 5699, quantity: 1 },
        { productId: "b", unitPrice: 8999, quantity: 1 },
      ],
      discount: { type: "PERCENT", value: 10 },
      delivery: DELIVERY,
      deliveryMethod: "STANDARD",
      giftWrap: GIFT,
      giftWrapUnits: 1,
    });
    // subtotal 14698, discount 1469 (1469.8 floored), free delivery (>=3000), gift 150 × 1
    expect(result.subtotal).toBe(14698);
    expect(result.discountTotal).toBe(1469);
    expect(result.deliveryFee).toBe(0);
    expect(result.giftWrapCharge).toBe(150);
    expect(result.total).toBe(14698 - 1469 + 0 + 150);
  });

  it("per-item wrap: only the ticked unit is charged in a mixed cart", () => {
    const result = computeOrderPricing({
      lines: [
        { productId: "a", unitPrice: 3000, quantity: 1 }, // wrapped
        { productId: "b", unitPrice: 2000, quantity: 2 }, // not wrapped
      ],
      discount: null,
      delivery: DELIVERY,
      deliveryMethod: "STANDARD",
      giftWrap: GIFT,
      giftWrapUnits: 1, // only product "a"'s single unit is wrapped
    });
    expect(result.subtotal).toBe(7000);
    expect(result.giftWrapCharge).toBe(150);
    expect(result.total).toBe(7000 + 0 + 150); // free delivery at 7000 >= 3000
  });

  it("quantity of a wrapped line multiplies the charge", () => {
    const result = computeOrderPricing({
      lines: [{ productId: "a", unitPrice: 1000, quantity: 3 }],
      discount: null,
      delivery: DELIVERY,
      deliveryMethod: "STANDARD",
      giftWrap: GIFT,
      giftWrapUnits: 3,
    });
    expect(result.giftWrapCharge).toBe(450);
    expect(result.total).toBe(3000 + 0 + 450); // free delivery: subtotal 3000 >= threshold 3000
  });

  it("small cart pays delivery; no gift wrap unless a unit is wrapped", () => {
    const result = computeOrderPricing({
      lines: [{ productId: "a", unitPrice: 1500, quantity: 1 }],
      discount: null,
      delivery: DELIVERY,
      deliveryMethod: "STANDARD",
      giftWrap: GIFT,
      giftWrapUnits: 0,
    });
    expect(result.total).toBe(1700); // 1500 + 200
  });

  it("express adds fee on top of free standard threshold", () => {
    const result = computeOrderPricing({
      lines: [{ productId: "a", unitPrice: 8000, quantity: 1 }],
      discount: null,
      delivery: DELIVERY,
      deliveryMethod: "EXPRESS",
      giftWrap: GIFT,
      giftWrapUnits: 0,
    });
    expect(result.total).toBe(8400); // 8000 + 400 express
  });
});

describe("discountPercent — product card badges", () => {
  it("derives percent from comparePrice", () => {
    expect(discountPercent(8999, 10999)).toBe(18);
    expect(discountPercent(5000, 5000)).toBeNull();
    expect(discountPercent(5000, 4000)).toBeNull(); // compare must be higher
    expect(discountPercent(5000, null)).toBeNull();
  });
});
