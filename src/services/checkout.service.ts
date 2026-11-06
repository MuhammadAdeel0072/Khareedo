// Checkout service — the transactional heart of Khareedo.
// Implements FR-18..27, BR-04..BR-09 with:
//   • server-side revalidation of prices & stock (never trusts the browser)
//   • single DB transaction per order (consistency, NFR-07)
//   • unique idempotency key (no duplicate orders, FR-27/BR-08)
//   • safe concurrent stock decrement guarded by conditional update
import { db } from "@/lib/db";
import { computeOrderPricing, computeDiscount, computeGiftWrapCharge, type DiscountRule } from "@/lib/pricing";
import { getSettings } from "@/services/settings.service";
import { reserveCoupon, validateCoupon } from "@/services/promotions.service";
import { generateOrderReference } from "@/lib/utils";
import type { PlaceOrderInput } from "@/lib/validation";
import { withPerformanceTiming } from "@/lib/performance-timing";

export interface QuoteInput {
  deliveryMethod: "STANDARD" | "EXPRESS";
  couponCode?: string;
}

export interface QuoteResult {
  subtotal: number;
  discountTotal: number;
  deliveryFee: number;
  giftWrapCharge: number;
  /** Purchasable units flagged for wrapping — lets the UI say "2 items" instead of a bare amount. */
  wrappedUnits: number;
  taxTotal: number;
  total: number;
  couponError?: string;
  couponApplied?: string;
  freeDeliveryThreshold: number;
  itemCount: number;
}

/**
 * Quote = authoritative server-side price preview shown BEFORE confirmation (BR-07).
 * Reuses exactly the same pipeline as placeOrder (NFR-30).
 */
export async function quoteOrder(input: QuoteInput): Promise<QuoteResult> {
  return withPerformanceTiming("checkout.quote", () => quoteOrderImpl(input));
}

async function quoteOrderImpl(input: QuoteInput): Promise<QuoteResult> {
  const { getCartDetails } = await import("@/services/cart.service");
  const [settings, cart] = await Promise.all([getSettings(), getCartDetails()]);
  const items = (cart?.items ?? []).filter((i) => !i.outOfStock);

  const lines = items.map((i) => ({ productId: i.productId, unitPrice: i.price, quantity: i.quantity }));
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

  let discountTotal = 0;
  let couponError: string | undefined;
  let couponApplied: string | undefined;
  let discountRule: DiscountRule | null = null;

  if (input.couponCode && subtotal > 0) {
    const result = await validateCoupon(input.couponCode, subtotal);
    if ("error" in result) {
      couponError = result.error;
    } else {
      discountRule = result.rule;
      discountTotal = computeDiscount(subtotal, result.rule);
      couponApplied = result.coupon.code;
    }
  }

  // Delivery: EXPRESS always charged; STANDARD free above threshold.
  // An empty cart quotes nothing — no phantom delivery fee (audit fix).
  const deliveryFee =
    items.length === 0
      ? 0
      : input.deliveryMethod === "EXPRESS"
        ? settings.delivery_fee_express
        : settings.free_delivery_threshold > 0 && subtotal >= settings.free_delivery_threshold
          ? 0
          : settings.delivery_fee_standard;

  // Gift wrap is PER ITEM: the flags live on the DB cart lines, so the server
  // knows exactly which products the customer asked to wrap (no client flag).
  const wrappedUnits = items.reduce(
    (s, i) => (i.giftWrap ? s + i.quantity : s),
    0
  );
  const giftWrapCharge = computeGiftWrapCharge(wrappedUnits, {
    enabled: settings.gift_wrap_enabled,
    charge: settings.gift_wrap_charge,
  });

  const total = Math.max(0, subtotal - discountTotal + deliveryFee + giftWrapCharge);

  return {
    subtotal,
    discountTotal,
    deliveryFee,
    giftWrapCharge,
    wrappedUnits: settings.gift_wrap_enabled ? wrappedUnits : 0,
    taxTotal: 0,
    total,
    couponError,
    couponApplied,
    freeDeliveryThreshold: settings.free_delivery_threshold,
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
  };
}

export interface PlaceOrderResult {
  ok: true;
  reference: string;
  orderId: string;
}
export interface PlaceOrderError {
  ok: false;
  error: string;
  code: "EMPTY_CART" | "OUT_OF_STOCK" | "DUPLICATE" | "VALIDATION" | "PAYMENT_DISABLED" | "AUTHENTICATION_REQUIRED" | "ERROR";
  reference?: string;
}

/**
 * Place an order:
 *  1. re-fetch cart from DB with current prices (BR-04)
 *  2. validate stock for every line (BR-05)
 *  3. compute totals server-side (BR-06)
 *  4. transaction: create order + items + payment record + decrement stock
 *  5. idempotency: unique key → duplicate submissions return the SAME order (FR-27)
 */
export async function placeOrder(
  input: PlaceOrderInput,
  userId: string
): Promise<PlaceOrderResult | PlaceOrderError> {
  return withPerformanceTiming("checkout.place", () => placeOrderImpl(input, userId));
}

async function placeOrderImpl(
  input: PlaceOrderInput,
  userId: string
): Promise<PlaceOrderResult | PlaceOrderError> {
  if (typeof userId !== "string" || !userId.trim()) {
    return { ok: false, error: "Please sign in to place an order.", code: "AUTHENTICATION_REQUIRED" };
  }

  const settings = await getSettings();

  // Payment method guards (BR-10, D-02): no fake online confirmations
  if (input.paymentMethod === "COD" && !settings.cod_enabled)
    return { ok: false, error: "Cash on Delivery is currently unavailable.", code: "PAYMENT_DISABLED" };
  if (input.paymentMethod === "ONLINE")
    return {
      ok: false,
      error: "Online payments are coming soon. Please choose Cash on Delivery.",
      code: "PAYMENT_DISABLED",
    };
  if (input.paymentMethod === "BANK_TRANSFER" && !settings.bank_transfer_enabled)
    return { ok: false, error: "Bank transfer is currently unavailable.", code: "PAYMENT_DISABLED" };

  // Idempotency fast-path (FR-27): same key → return original order
  const existing = await db.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { reference: true, id: true, userId: true, isGuest: true },
  });
  if (existing) {
    if (existing.userId !== userId || existing.isGuest) {
      return { ok: false, error: "This checkout request cannot be reused.", code: "DUPLICATE" };
    }
    return { ok: true, reference: existing.reference, orderId: existing.id };
  }

  const { getCartDetails } = await import("@/services/cart.service");
  const cart = await getCartDetails();
  if (!cart || cart.items.length === 0)
    return { ok: false, error: "Your cart is empty.", code: "EMPTY_CART" };

  const purchasable = cart.items.filter((i) => !i.outOfStock);
  if (purchasable.length === 0)
    return { ok: false, error: "All items in your cart are out of stock.", code: "OUT_OF_STOCK" };

  // Stock re-validation (BR-05)
  for (const item of purchasable) {
    if (item.quantity > item.stock) {
      return {
        ok: false,
        error: `Only ${item.stock} unit(s) of "${item.name}" left in stock. Please update your cart.`,
        code: "OUT_OF_STOCK",
      };
    }
  }

  const subtotal = purchasable.reduce((s, i) => s + i.price * i.quantity, 0);

  const deliveryFee =
    input.deliveryMethod === "EXPRESS"
      ? settings.delivery_fee_express
      : settings.free_delivery_threshold > 0 && subtotal >= settings.free_delivery_threshold
        ? 0
        : settings.delivery_fee_standard;

  // Per-item gift wrap from DB cart flags (BR-04): wrap charge scales with wrapped units
  const wrappedUnits = purchasable.reduce((s, i) => (i.giftWrap ? s + i.quantity : s), 0);
  const giftWrapCharge = computeGiftWrapCharge(wrappedUnits, {
    enabled: settings.gift_wrap_enabled,
    charge: settings.gift_wrap_charge,
  });

  const reference = generateOrderReference();

  try {
    const order = await withPerformanceTiming("checkout.place.transaction", () =>
      db.$transaction(
      async (tx) => {
      const couponResult = input.couponCode
        ? await reserveCoupon(tx, input.couponCode, subtotal)
        : null;
      const discountRule =
        couponResult && "rule" in couponResult ? couponResult.rule : null;
      const couponCode =
        couponResult && "coupon" in couponResult ? couponResult.coupon.code : null;
      const discountTotal = discountRule ? computeDiscount(subtotal, discountRule) : 0;
      const total = Math.max(0, subtotal - discountTotal + deliveryFee + giftWrapCharge);

      const created = await tx.order.create({
        data: {
          reference,
          idempotencyKey: input.idempotencyKey,
          userId,
          isGuest: false,
          customerName: input.customer.name,
          customerEmail: input.customer.email,
          customerPhone: input.customer.phone,
          shipFullName: input.address.fullName,
          shipPhone: input.address.phone,
          shipLine1: input.address.line1,
          shipLine2: input.address.line2 || null,
          shipCity: input.address.city,
          shipProvince: input.address.province,
          shipPostalCode: input.address.postalCode || null,
          status: "CONFIRMED",
          paymentMethod: input.paymentMethod,
          paymentStatus: "PENDING",
          subtotal,
          discountTotal,
          deliveryFee,
          deliveryMethod: input.deliveryMethod,
          giftWrapCharge,
          giftWrapSelected: giftWrapCharge > 0,
          giftWrapMessage: input.giftWrapMessage || null,
          couponCode,
          couponTitle: discountRule?.title ?? null,
          total,
          notes: input.notes || null,
          items: {
            create: purchasable.map((i) => ({
              productId: i.productId,
              productName: i.name,
              productSlug: i.slug,
              imageUrl: i.image,
              unitPrice: i.price,
              quantity: i.quantity,
              lineTotal: i.price * i.quantity,
              giftWrap: i.giftWrap && settings.gift_wrap_enabled,
            })),
          },
          payments: {
            create: {
              provider: input.paymentMethod,
              amount: total,
              status: "PENDING",
            },
          },
        },
        select: { id: true, reference: true },
      });

      // Safe concurrent stock decrement — conditional update per line (BR-05):
      // only decrements when enough stock remains; otherwise aborts the transaction.
      for (const item of purchasable) {
        const res = await tx.inventory.updateMany({
          where: { productId: item.productId, quantity: { gte: item.quantity } },
          data: { quantity: { decrement: item.quantity }, version: { increment: 1 } },
        });
        if (res.count === 0) {
          throw new StockConflictError(item.name, item.stock);
        }
      }

      return created;
    },
    // Concurrent checkouts queue on SQLite's single-writer lock; the default
    // 5s budget aborts queued transactions mid-flight (audit: race test).
    // 15s lets every queued writer finish and take the clean OUT_OF_STOCK path.
    { maxWait: 5_000, timeout: 15_000 }
      )
    );

    // Clear the cart after successful placement
    const { clearCart } = await import("@/services/cart.service");
    await clearCart(cart.id);

    return { ok: true, reference: order.reference, orderId: order.id };
  } catch (e) {
    if (e instanceof StockConflictError) {
      return {
        ok: false,
        error: `Sorry — "${e.productName}" just sold out or has insufficient stock (${e.available} left). Please update your cart.`,
        code: "OUT_OF_STOCK",
      };
    }
    // Unique constraint on idempotencyKey → concurrent duplicate submission
    if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002") {
      const dup = await db.order.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { reference: true, id: true, userId: true, isGuest: true },
      });
      if (dup && dup.userId === userId && !dup.isGuest) {
        return { ok: true, reference: dup.reference, orderId: dup.id };
      }
      return { ok: false, error: "Duplicate order submission detected.", code: "DUPLICATE" };
    }
    // Contention (SQLite single-writer / pool starvation under burst):
    // classify honestly as "store busy, retry" instead of a generic failure.
    const msg = typeof e === "object" && e !== null ? String((e as { message?: string }).message ?? "") : "";
    if (
      msg.includes("Transaction already closed") ||
      msg.includes("Timed out fetching a new connection") ||
      msg.includes("database is locked") ||
      (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2024")
    ) {
      return {
        ok: false,
        error: "The store is busy right now — please try again in a moment.",
        code: "ERROR",
      };
    }
    return { ok: false, error: "Something went wrong while placing your order. Please try again.", code: "ERROR" };
  }
}

class StockConflictError extends Error {
  productName: string;
  available: number;
  constructor(productName: string, available: number) {
    super("stock conflict");
    this.productName = productName;
    this.available = available;
  }
}
