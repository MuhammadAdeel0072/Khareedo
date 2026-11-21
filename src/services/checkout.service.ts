// Checkout service — the transactional heart of Khareedo.
// Implements FR-18..27, BR-04..BR-09 with:
//   • server-side revalidation of prices & stock (never trusts the browser)
//   • single DB transaction per order (consistency, NFR-07)
//   • unique idempotency key (no duplicate orders, FR-27/BR-08)
//   • safe concurrent stock decrement guarded by conditional update
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { computeOrderPricing, computeDiscount, computeGiftWrapCharge, type DiscountRule } from "@/lib/pricing";
import { getSettings } from "@/services/settings.service";
import { reserveCoupon, findCouponByCode, evaluateAutomaticPromotion } from "@/services/promotions.service";
import { validateCouponRecord, checkCouponUserEligibility, isPerUserCouponViolation, isFirstOrderClaimViolation } from "@/lib/coupon-validation";
import { generateOrderReference } from "@/lib/utils";
import type { PlaceOrderInput } from "@/lib/validation";
import { withPerformanceTiming } from "@/lib/performance-timing";
import { recordOrderStatusHistory } from "@/services/order-status-history.service";
import { enqueueOrderConfirmedEmail } from "@/services/order-notification.service";

/** One cart line as re-read inside the order transaction: live product
 *  status/price/stock, never a cached or client-supplied value. */
interface CheckoutLine {
  itemId: string;
  productId: string;
  /** Null = the product itself (no variant). */
  variantId: string | null;
  variantLabel: string | null;
  variantSku: string | null;
  name: string;
  slug: string;
  image: string | null;
  /** Effective unit price: the variant's absolute override when set, else
   *  the product price (Chunk 8 — D12). */
  price: number;
  /** Stored CartItem quantity — the transaction rejects it when it exceeds
   *  live stock instead of silently fulfilling less (H-19). */
  quantity: number;
  giftWrap: boolean;
  status: string;
  deletedAt: Date | null;
  stock: number | null;
  /** Set when the line's variant is gone or deactivated. */
  variantProblem: string | null;
}

type CartLineRow = {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  giftWrap: boolean;
  variant: {
    id: string;
    label: string;
    sku: string;
    priceOverride: number | null;
    isActive: boolean;
    inventory: { quantity: number } | null;
  } | null;
  product: {
    name: string;
    slug: string;
    price: number;
    status: string;
    deletedAt: Date | null;
    inventory: Array<{ variantId: string | null; quantity: number }>;
    /** Present only on the in-transaction re-read: the pre-transaction
     *  read omits images (they are only needed for the order-item
     *  snapshot written inside the transaction). */
    images?: Array<{ url: string }>;
  };
};

function toCheckoutLines(items: CartLineRow[]): CheckoutLine[] {
  return items.map((item) => {
    // A variant line prices and stocks against the VARIANT: its absolute
    // override replaces the product price, its own inventory row is the
    // stock. A line whose variant is gone or deactivated is unfulfillable
    // (reported by lineAvailabilityProblem below) — never silently
    // converted to a no-variant line.
    const variant = item.variantId ? item.variant : null;
    const variantProblem =
      item.variantId && !variant
        ? `"${item.product.name}" variant is no longer available`
        : variant && !variant.isActive
          ? `"${item.product.name} (${variant.label})" is no longer available`
          : null;
    return {
      itemId: item.id,
      productId: item.productId,
      variantId: item.variantId,
      variantLabel: variant?.label ?? null,
      variantSku: variant?.sku ?? null,
      name: item.product.name,
      slug: item.product.slug,
      image: item.product.images?.[0]?.url ?? null,
      price: variant?.priceOverride ?? item.product.price,
      quantity: item.quantity,
      giftWrap: item.giftWrap,
      status: item.product.status,
      deletedAt: item.product.deletedAt,
      stock: variant
        ? variant.inventory?.quantity ?? 0
        : item.product.inventory.find((r) => r.variantId === null)?.quantity ?? 0,
      variantProblem,
    };
  });
}

/** Human-readable reason a line cannot be fulfilled, or null when it can. */
function lineAvailabilityProblem(line: CheckoutLine): string | null {
  if (line.variantProblem) return line.variantProblem;
  if (line.status !== "PUBLISHED" || line.deletedAt) return `"${line.name}" is no longer available`;
  if (line.quantity < 1) return `"${line.name}" has an invalid quantity`;
  if (line.price < 1) return `"${line.name}" has an invalid price`;
  const stock = line.stock ?? 0;
  if (stock <= 0) return `"${line.name}" is out of stock`;
  if (line.quantity > stock) return `"${line.name}" — only ${stock} left in stock`;
  return null;
}

/** Checkout fingerprint (Phase 3, M-10): binds an idempotency key to the
 *  exact submission it was created for — customer, address, delivery,
 *  payment method, coupon and cart. Mirrors the Safepay path
 *  (safepay-pending-order.service.ts): a replay with the same key but a
 *  different fingerprint must NOT silently return the old order. */
function checkoutFingerprint(
  userId: string,
  cartId: string | null,
  input: PlaceOrderInput
): string {
  const normalized = {
    ...input,
    idempotencyKey: undefined,
    couponCode: input.couponCode?.trim().toUpperCase() || undefined,
    giftWrapMessage: input.giftWrapMessage?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
  };
  return createHash("sha256")
    .update(JSON.stringify(["CHECKOUT_SUBMISSION_V1", userId, cartId, normalized]))
    .digest("hex");
}

class CouponUnavailableError extends Error {}
class CartChangedError extends Error {}
class EmptyCartError extends Error {}
class LineAvailabilityError extends Error {}
/** COD minimum (D17): a COD order's total must be at least Rs 1. */
class CodMinimumError extends Error {}

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
  /** Title of the automatic promotion that discounted this quote, if any (D10). */
  promotionApplied?: string;
  freeDeliveryThreshold: number;
  itemCount: number;
}

/**
 * Quote = authoritative server-side price preview shown BEFORE confirmation (BR-07).
 * Reuses exactly the same pipeline as placeOrder (NFR-30).
 */
export async function quoteOrder(input: QuoteInput, userId?: string): Promise<QuoteResult> {
  return withPerformanceTiming("checkout.quote", () => quoteOrderImpl(input, userId));
}

async function quoteOrderImpl(input: QuoteInput, userId?: string): Promise<QuoteResult> {
  const { getCartDetails } = await import("@/services/cart.service");
  // The coupon row is independent of settings/cart — fetch it in the same
  // batch and validate synchronously against the computed subtotal (one
  // fewer sequential round trip on the quote path).
  const couponPromise = input.couponCode
    ? findCouponByCode(input.couponCode)
    : Promise.resolve(null);
  const [settings, cart, couponRecord] = await Promise.all([
    getSettings(),
    getCartDetails(),
    couponPromise,
  ]);
  const items = (cart?.items ?? []).filter((i) => !i.outOfStock);

  const lines = items.map((i) => ({ productId: i.productId, unitPrice: i.price, quantity: i.quantity }));
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

  let discountTotal = 0;
  let couponError: string | undefined;
  let couponApplied: string | undefined;
  let promotionApplied: string | undefined;
  let discountRule: DiscountRule | null = null;

  // An unknown code is a real answer, not silence (Phase 3, M-34): without
  // it the UI sits on "checking…" forever for a code that will never apply.
  if (input.couponCode && !couponRecord) {
    couponError = "This coupon code is not valid.";
  } else if (couponRecord && subtotal > 0) {
    const result = validateCouponRecord(couponRecord, subtotal);
    if ("error" in result) {
      couponError = result.error;
    } else {
      // Per-user limit + first-order-only (D11/M-20): the quote is a
      // preview, so this is advisory — the reservation re-checks in the
      // place-order transaction. Without a user there is nothing to check.
      const eligibility = userId
        ? await checkCouponUserEligibility(db, result.coupon, userId)
        : null;
      if (eligibility) {
        couponError = eligibility.error;
      } else {
        discountRule = result.rule;
        discountTotal = computeDiscount(subtotal, result.rule);
        couponApplied = result.coupon.code;
      }
    }
  } else if (!input.couponCode) {
    // No coupon supplied: the best applicable automatic promotion applies
    // instead (D10). A supplied coupon is authoritative — it either applies
    // or errors above; a promotion never stacks with it and never silently
    // substitutes for a rejected coupon.
    const promo = await evaluateAutomaticPromotion(db, subtotal);
    if (promo) {
      discountRule = promo.rule;
      discountTotal = promo.discountTotal;
      promotionApplied = promo.promotion.title;
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
    promotionApplied,
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
  code: "EMPTY_CART" | "OUT_OF_STOCK" | "DUPLICATE" | "VALIDATION" | "PAYMENT_DISABLED" | "AUTHENTICATION_REQUIRED" | "COUPON_UNAVAILABLE" | "MINIMUM_NOT_MET" | "BUSY" | "ERROR";
  reference?: string;
}

/**
 * Place an order:
 *  1. read the cart from the DB by userId (no request-scoped resolver)
 *  2. idempotency: unique key + checkout fingerprint — a replay with the
 *     same key but different details is a conflict, not the old order (M-10)
 *  3. transaction: lock the cart row, re-read every line against live
 *     prices/status/stock, reserve the coupon, create order + items +
 *     payment, decrement stock, consume the cart lines (H-4/M-11, H-5,
 *     H-19, M-8). Any unavailable line or unreservable coupon fails the
 *     whole order — nothing is silently dropped or charged at full price.
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

  // Settings and the cart read are independent — one batch instead of two
  // sequential round trips. The cart is read directly by userId (this
  // service already receives the authenticated user; it must not depend on
  // the request-scoped cart resolver) and its id feeds the checkout
  // fingerprint (M-10), so it is read BEFORE the idempotency probe.
  // The pre-transaction read deliberately omits product images: they are
  // only needed for the order-item snapshot, which is built from the
  // in-transaction re-read below. Fetching them here cost one join per
  // line on every checkout attempt, including the fast-fail pre-checks.
  const [settings, cartRow] = await Promise.all([
    getSettings(),
    db.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            variant: { include: { inventory: true } },
            product: {
              include: {
                inventory: true,
              },
            },
          },
        },
      },
    }),
  ]);
  const cartId = cartRow?.id ?? null;
  const fingerprint = checkoutFingerprint(userId, cartId, input);

  // Payment method guards (BR-10, D-02): no fake online confirmations, and
  // bank transfer is not supported. placeOrderSchema rejects BANK_TRANSFER
  // before this service runs; this guard is defense in depth for direct
  // callers, so an untyped or future caller cannot create a bank-transfer
  // order by bypassing the route validation.
  if (input.paymentMethod !== "COD" && input.paymentMethod !== "ONLINE")
    return { ok: false, error: "This payment method is not supported.", code: "PAYMENT_DISABLED" };
  if (input.paymentMethod === "COD" && !settings.cod_enabled)
    return { ok: false, error: "Cash on Delivery is currently unavailable.", code: "PAYMENT_DISABLED" };
  if (input.paymentMethod === "ONLINE")
    return {
      ok: false,
      error: "Online payments are coming soon. Please choose Cash on Delivery.",
      code: "PAYMENT_DISABLED",
    };

  const existing = await db.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { reference: true, id: true, userId: true, isGuest: true, checkoutFingerprint: true },
  });

  if (existing) {
    if (existing.userId !== userId || existing.isGuest) {
      return { ok: false, error: "This checkout request cannot be reused.", code: "DUPLICATE" };
    }
    // Fingerprint binding (M-10): the same key with different submission
    // details (address, coupon, cart) must NOT silently return the old
    // order. A NULL stored fingerprint is a pre-binding order — accept it.
    if (existing.checkoutFingerprint && existing.checkoutFingerprint !== fingerprint) {
      return {
        ok: false,
        error: "This checkout request does not match the original order. Please start a new checkout.",
        code: "DUPLICATE",
      };
    }
    return { ok: true, reference: existing.reference, orderId: existing.id };
  }

  // Fast-fail pre-checks (BR-05). These are stale reads by design — the
  // transaction below re-reads the cart under a row lock and re-validates
  // every line against live prices, status and stock (H-4/M-11, H-19).
  const preCheckLines = toCheckoutLines(cartRow?.items ?? []);
  if (preCheckLines.length === 0)
    return { ok: false, error: "Your cart is empty.", code: "EMPTY_CART" };
  const preCheckProblems = preCheckLines
    .map(lineAvailabilityProblem)
    .filter((p): p is string => p !== null);
  if (preCheckProblems.length > 0) {
    return {
      ok: false,
      error: `The following items are no longer available: ${preCheckProblems.join(", ")}. Please update your cart.`,
      code: "OUT_OF_STOCK",
    };
  }

  const reference = generateOrderReference();
  const now = new Date();

  try {
    const order = await withPerformanceTiming("checkout.place.transaction", () =>
      db.$transaction(
      async (tx) => {
      // Lock the cart before reading it (H-4/M-11 — mirrors the Safepay
      // path): a second checkout of the same cart queues on this row lock,
      // then re-reads the post-commit cart and finds its lines consumed,
      // so two different-key checkouts of one cart can never double-order.
      const locked = await tx.cart.updateMany({
        where: { id: cartId!, userId },
        data: { updatedAt: now },
      });
      if (locked.count !== 1) throw new CartChangedError();
      const lockedCart = await tx.cart.findUniqueOrThrow({
        where: { id: cartId! },
        include: {
          items: {
            orderBy: { productId: "asc" },
            include: {
              variant: { include: { inventory: true } },
              product: {
                include: {
                  inventory: true,
                  images: { orderBy: { sortOrder: "asc" }, take: 1 },
                },
              },
            },
          },
        },
      });
      const lines = toCheckoutLines(lockedCart.items);
      if (lines.length === 0) throw new EmptyCartError();
      // Unlike a preview, checkout never silently drops unavailable lines
      // (H-19): every line is re-checked against live status, price and
      // stock inside this transaction, and any offender rejects the order
      // by name.
      const problems = lines
        .map(lineAvailabilityProblem)
        .filter((p): p is string => p !== null);
      if (problems.length > 0) {
        throw new LineAvailabilityError(
          `The following items are no longer available: ${problems.join(", ")}. Please update your cart.`
        );
      }
      // Totals are computed inside the transaction from live prices (BR-04/06):
      // the pre-check subtotal above is a stale read and must never price an order.
      const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
      const deliveryFee =
        input.deliveryMethod === "EXPRESS"
          ? settings.delivery_fee_express
          : settings.free_delivery_threshold > 0 && subtotal >= settings.free_delivery_threshold
            ? 0
            : settings.delivery_fee_standard;
      const wrappedUnits = lines.reduce((s, l) => (l.giftWrap ? s + l.quantity : s), 0);
      const giftWrapCharge = computeGiftWrapCharge(wrappedUnits, {
        enabled: settings.gift_wrap_enabled,
        charge: settings.gift_wrap_charge,
      });

      // Discount precedence (D10): exactly one source. A supplied coupon is
      // authoritative — it must reserve or the order fails (H-5). With no
      // coupon, the best applicable automatic promotion applies instead; it
      // never stacks with a coupon. The order records which source won
      // (couponCode XOR promotionId).
      let discountRule: DiscountRule | null = null;
      let couponCode: string | null = null;
      let couponFirstOrderOnly = false;
      let promotionId: string | null = null;
      let promotionTitle: string | null = null;
      if (input.couponCode) {
        const couponResult = await reserveCoupon(tx, input.couponCode, subtotal, userId);
        if ("error" in couponResult) {
          throw new CouponUnavailableError(couponResult.error);
        }
        discountRule = couponResult.rule;
        couponCode = couponResult.coupon.code;
        // First-order claim (R-1, migration 20261121000001): the flag is
        // carried onto the order row below, where the partial unique
        // index makes it the atomic guard — two concurrent first orders
        // with different first-order coupons cannot both insert.
        couponFirstOrderOnly = couponResult.coupon.firstOrderOnly;
      } else {
        const promo = await evaluateAutomaticPromotion(tx, subtotal);
        if (promo) {
          discountRule = promo.rule;
          promotionId = promo.promotion.id;
          promotionTitle = promo.promotion.title;
        }
      }
      const discountTotal = discountRule ? computeDiscount(subtotal, discountRule) : 0;
      const total = Math.max(0, subtotal - discountTotal + deliveryFee + giftWrapCharge);

      // COD minimum (D17): a COD order's total must be at least Rs 1 AFTER
      // discounts and delivery, on the authoritative server-side total
      // computed above — never on a stale pre-check. A Rs 0 COD order (full
      // coupon + free delivery) is rejected, not placed.
      if (input.paymentMethod === "COD" && total < 1) {
        throw new CodMinimumError();
      }

      const created = await tx.order.create({
        data: {
          reference,
          idempotencyKey: input.idempotencyKey,
          checkoutFingerprint: fingerprint,
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
          couponTitle: couponCode ? discountRule?.title ?? null : null,
          firstOrderCoupon: couponFirstOrderOnly,
          promotionId,
          promotionTitle,
          total,
          notes: input.notes || null,
          items: {
            create: lines.map((l) => ({
              productId: l.productId,
              variantId: l.variantId,
              variantLabel: l.variantLabel,
              variantSku: l.variantSku,
              productName: l.name,
              productSlug: l.slug,
              imageUrl: l.image,
              unitPrice: l.price,
              quantity: l.quantity,
              lineTotal: l.price * l.quantity,
              giftWrap: l.giftWrap && settings.gift_wrap_enabled,
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

      // Status history (M-6): the placement itself is the first timeline
      // entry, written in the same transaction as the order.
      await recordOrderStatusHistory(tx, {
        orderId: created.id,
        status: "CONFIRMED",
        actor: `customer:${userId}`,
        note: "Order placed",
      });

      // Safe concurrent stock decrement — conditional update per line (BR-05):
      // only decrements when enough stock remains; otherwise aborts the transaction.
      // A variant line decrements the VARIANT's inventory row, a no-variant
      // line the product-level row (Chunk 8 — D12): the variantId in the
      // predicate is what keeps two variants of one product from sharing a
      // stock pool. `variantId: null` in an updateMany where means IS NULL.
      //
      // Batched by quantity: Prisma applies one `data` to every row an
      // updateMany matches, so lines sharing a quantity share one call
      // (typically 1–2 calls for a whole cart instead of one per line).
      // The batching is exact, not approximate: CartItem carries
      // @@unique([cartId, productId, variantId]), so two lines can never
      // address the same inventory row and no row is decremented twice;
      // each OR branch additionally requires quantity >= the line's
      // quantity, so a shortfall on ANY line shows up as an affected-row
      // count below lines.length. The shortfall path re-reads live stock
      // to name the failing line — the per-line failure attribution of
      // the old loop is preserved.
      const linesByQuantity = new Map<number, CheckoutLine[]>();
      for (const line of lines) {
        const group = linesByQuantity.get(line.quantity);
        if (group) group.push(line);
        else linesByQuantity.set(line.quantity, [line]);
      }
      let decremented = 0;
      for (const [quantity, group] of linesByQuantity) {
        const res = await tx.inventory.updateMany({
          where: {
            OR: group.map((item) => ({
              productId: item.productId,
              variantId: item.variantId ?? null,
              quantity: { gte: quantity },
            })),
          },
          data: { quantity: { decrement: quantity }, version: { increment: 1 } },
        });
        decremented += res.count;
      }
      if (decremented !== lines.length) {
        // A racing sale drained (or removed) one of the rows after the
        // in-transaction availability check: find which line can no
        // longer be fulfilled and report it by name, as before.
        const liveRows = await tx.inventory.findMany({
          where: {
            OR: lines.map((l) => ({ productId: l.productId, variantId: l.variantId ?? null })),
          },
          select: { productId: true, variantId: true, quantity: true },
        });
        const failing = lines.find((l) => {
          const row = liveRows.find(
            (r) => r.productId === l.productId && (r.variantId ?? null) === (l.variantId ?? null)
          );
          return (row?.quantity ?? 0) < l.quantity;
        });
        const failingRow = failing
          ? liveRows.find(
              (r) => r.productId === failing.productId && (r.variantId ?? null) === (failing.variantId ?? null)
            )
          : undefined;
        throw new StockConflictError(
          failing?.name ?? lines[0].name,
          failingRow?.quantity ?? 0
        );
      }

      // Consume the cart lines inside this transaction (M-8): only the exact
      // snapshot is removed, so a concurrent cart edit aborts instead of
      // disappearing — mirrors the Safepay path. One deleteMany with an OR
      // of the per-line predicates: each predicate matches at most one row
      // (id is unique) and distinct lines have distinct ids, so the
      // affected-row count IS the per-line guard — a count below
      // lines.length means a line changed concurrently.
      const removed = await tx.cartItem.deleteMany({
        where: {
          OR: lines.map((line) => ({
            id: line.itemId,
            cartId: cartId!,
            quantity: line.quantity,
            giftWrap: line.giftWrap,
          })),
        },
      });
      if (removed.count !== lines.length) throw new CartChangedError();

      return created;
    },
    // Concurrent checkouts queue on SQLite's single-writer lock; the default
    // 5s budget aborts queued transactions mid-flight (audit: race test).
    // 15s lets every queued writer finish and take the clean OUT_OF_STOCK path.
    { maxWait: 5_000, timeout: 15_000 }
      )
    );

    // Order confirmation email (Chunk 7-final — D14): COD only —
    // placeOrder rejects ONLINE above, and a Safepay order is confirmed at
    // verified settlement, not here. Fresh placement only: the idempotency
    // replay paths above return the old order without re-enqueueing (the
    // outbox dedup is the second guard). Best-effort by design: the
    // notification function never throws, so a mail problem cannot fail
    // an order that already committed.
    await enqueueOrderConfirmedEmail({ orderId: order.id });
    return { ok: true, reference: order.reference, orderId: order.id };
  } catch (e) {
    if (e instanceof CouponUnavailableError) {
      return { ok: false, error: e.message, code: "COUPON_UNAVAILABLE" };
    }
    if (e instanceof CodMinimumError) {
      return {
        ok: false,
        error: "Cash on Delivery requires a minimum order total of Rs 1.",
        code: "MINIMUM_NOT_MET",
      };
    }
    if (e instanceof LineAvailabilityError) {
      return { ok: false, error: e.message, code: "OUT_OF_STOCK" };
    }
    if (e instanceof EmptyCartError) {
      return { ok: false, error: "Your cart is empty.", code: "EMPTY_CART" };
    }
    if (e instanceof CartChangedError) {
      return {
        ok: false,
        error: "Your cart changed while placing the order. Please try again.",
        code: "ERROR",
      };
    }
    if (e instanceof StockConflictError) {
      return {
        ok: false,
        error: `Sorry — "${e.productName}" just sold out or has insufficient stock (${e.available} left). Please update your cart.`,
        code: "OUT_OF_STOCK",
      };
    }
    // The one-redemption-per-user index (migration 20261120000006) is the
    // atomic guard: a racing second order for the same user + coupon fails
    // here even though its pre-check read zero prior orders. It is a
    // coupon error, not a duplicate submission.
    if (isPerUserCouponViolation(e)) {
      return { ok: false, error: "You have already used this coupon.", code: "COUPON_UNAVAILABLE" };
    }
    // The first-order claim (migration 20261121000001) is the atomic
    // guard: a racing second first order for the same user — with a
    // DIFFERENT first-order-only coupon, so the per-user index above
    // cannot see it — fails its order.create with P2002 even though its
    // pre-check read zero prior orders. It is a coupon error, not a
    // duplicate submission, and must be caught BEFORE the generic P2002
    // idempotency handling below: the order is rejected with the
    // existing first-order error, the coupon is not silently dropped,
    // and the order is not placed without it.
    if (isFirstOrderClaimViolation(e)) {
      return { ok: false, error: "This coupon is only valid for your first order.", code: "COUPON_UNAVAILABLE" };
    }
    // Unique constraint on idempotencyKey → concurrent duplicate submission
    if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002") {
      const dup = await db.order.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { reference: true, id: true, userId: true, isGuest: true, checkoutFingerprint: true },
      });
      if (dup && dup.userId === userId && !dup.isGuest) {
        // Same fingerprint binding as the pre-check replay path (M-10).
        if (dup.checkoutFingerprint && dup.checkoutFingerprint !== fingerprint) {
          return {
            ok: false,
            error: "This checkout request does not match the original order. Please start a new checkout.",
            code: "DUPLICATE",
          };
        }
        return { ok: true, reference: dup.reference, orderId: dup.id };
      }
      return { ok: false, error: "Duplicate order submission detected.", code: "DUPLICATE" };
    }
    // Contention (SQLite single-writer / pool starvation under burst):
    // classify honestly as "store busy, retry" instead of a generic
    // failure (Phase 3, chunk 12 follow-up B). The code is BUSY so the
    // route maps it to 503 with Retry-After — a 422 told the client the
    // request itself was wrong, which it was not.
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
        code: "BUSY",
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
