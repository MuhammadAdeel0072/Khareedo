// Khareedo pricing engine — PURE functions, zero I/O (BR-04, BR-06, FR-21, FR-30).
// All money values are INTEGER PKR (whole rupees). The browser never supplies
// authoritative amounts; services call these functions with DB-fetched data.

export interface PricedLine {
  productId: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

/** Input line for the pricing pipeline — lineTotal is always DERIVED server-side, never trusted from input. */
export interface PricingLineInput {
  productId: string;
  unitPrice: number;
  quantity: number;
}

export interface DiscountRule {
  type: "PERCENT" | "FIXED";
  value: number; // percent 1-100, or fixed PKR amount
  title?: string;
}

export interface DeliveryConfig {
  standardFee: number;
  expressFee: number;
  freeThreshold: number; // standard delivery free when subtotal >= threshold (0 = never free)
}

export interface GiftWrapConfig {
  enabled: boolean;
  charge: number;
}

export interface PricingInput {
  lines: PricingLineInput[]; // server-validated lines with CURRENT DB prices (lineTotal derived, not trusted)
  discount?: DiscountRule | null; // coupon or promotion (already validated)
  delivery: DeliveryConfig;
  deliveryMethod: "STANDARD" | "EXPRESS";
  giftWrap: GiftWrapConfig;
  /** Number of ITEM UNITS the customer asked to gift-wrap (from DB cart flags — never client-supplied amounts). */
  giftWrapUnits: number;
}

export interface PricingResult {
  subtotal: number;
  discountTotal: number;
  deliveryFee: number;
  giftWrapCharge: number;
  taxTotal: number; // reserved — zero until a tax policy is confirmed
  total: number;
}

/** Clamp helper — integers only, never negative. */
function safeInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

/** Compute per-line totals and cart subtotal from current valid prices. */
export function computeLines(
  items: Array<{ productId: string; unitPrice: number; quantity: number }>
): { lines: PricedLine[]; subtotal: number } {
  const lines: PricedLine[] = items.map((i) => {
    const unitPrice = safeInt(i.unitPrice);
    const quantity = Math.max(1, Math.floor(i.quantity));
    return { productId: i.productId, unitPrice, quantity, lineTotal: unitPrice * quantity };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  return { lines, subtotal };
}

/** Coupon/promotion amount against a given subtotal (min-order already validated). */
export function computeDiscount(
  subtotal: number,
  rule?: DiscountRule | null
): number {
  if (!rule || subtotal <= 0) return 0;
  let d = 0;
  if (rule.type === "PERCENT") {
    d = Math.floor((subtotal * Math.min(100, Math.max(0, rule.value))) / 100);
  } else {
    d = safeInt(rule.value);
  }
  return Math.min(d, subtotal); // never exceed subtotal
}

/** Delivery fee per configured flat fees + free threshold (Standard only). */
export function computeDeliveryFee(
  subtotal: number,
  method: "STANDARD" | "EXPRESS",
  cfg: DeliveryConfig
): number {
  if (method === "EXPRESS") return safeInt(cfg.expressFee);
  if (cfg.freeThreshold > 0 && subtotal >= cfg.freeThreshold) return 0;
  return safeInt(cfg.standardFee);
}

/**
 * Gift-wrap charge: per wrapped ITEM UNIT (a unit = one physical gift package).
 * The wrapped-item list itself lives on the cart/order lines — this only prices it.
 */
export function computeGiftWrapCharge(
  wrappedUnits: number,
  cfg: GiftWrapConfig
): number {
  if (!cfg.enabled || wrappedUnits <= 0) return 0;
  return safeInt(wrappedUnits) * safeInt(cfg.charge);
}

/**
 * Full order pricing pipeline (BR-06):
 * total = subtotal − discount + delivery + giftWrap (+ tax when policy confirmed)
 */
export function computeOrderPricing(input: PricingInput): PricingResult {
  const { lines, subtotal } = computeLines(input.lines);
  const discountTotal = computeDiscount(subtotal, input.discount);
  const deliveryFee = computeDeliveryFee(subtotal, input.deliveryMethod, input.delivery);
  const giftWrapCharge = computeGiftWrapCharge(input.giftWrapUnits, input.giftWrap);
  const taxTotal = 0;
  const total = Math.max(0, subtotal - discountTotal + deliveryFee + giftWrapCharge + taxTotal);
  return { subtotal, discountTotal, deliveryFee, giftWrapCharge, taxTotal, total };
}

/** Discount badge percent for product cards (derived from comparePrice). */
export function discountPercent(price: number, comparePrice?: number | null): number | null {
  if (!comparePrice || comparePrice <= price) return null;
  return Math.round(((comparePrice - price) / comparePrice) * 100);
}
