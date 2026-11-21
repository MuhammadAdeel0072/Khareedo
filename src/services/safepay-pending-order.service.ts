import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { placeOrderSchema, checkoutAddressSchema, checkoutCustomerSchema } from "@/lib/validation";
import { computeOrderPricing, type DiscountRule } from "@/lib/pricing";
import type { Coupon } from "../../generated/postgres-client";
import { validateCouponRecord, checkCouponUserEligibility, isPerUserCouponViolation, isFirstOrderClaimViolation } from "@/lib/coupon-validation";
import { evaluateAutomaticPromotion } from "@/services/promotions.service";
import { wholePkrToMinor } from "@/lib/safepay/contracts";
import { generateOrderReference } from "@/lib/utils";
import type { StoreSettings } from "@/services/settings.service";
import { bindCheckoutOwner, type PaymentDatabase, type TrustedCheckoutOwner } from "@/services/safepay-attempt.store";
import { recordOrderStatusHistory } from "@/services/order-status-history.service";

const requestSchema = placeOrderSchema.extend({
  paymentMethod: z.literal("ONLINE"), customer: checkoutCustomerSchema.strict(), address: checkoutAddressSchema.strict(),
}).strict();
type FailureCode = "INVALID_REQUEST" | "NOT_ELIGIBLE" | "EMPTY_CART" | "OUT_OF_STOCK" | "COUPON_UNAVAILABLE" |
  "REQUEST_CONFLICT" | "CHECKOUT_CLOSED" | "BUSY" | "PERSISTENCE_UNAVAILABLE";
export type PendingOrderResult = { kind: "ready"; orderId: string; paymentId: string; reference: string; reused: boolean } |
  { kind: "blocked"; code: FailureCode };
class PendingConflict extends Error { constructor(readonly code: FailureCode) { super(code); } }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type TrustedPendingCheckout = { owner: TrustedCheckoutOwner; cartId: string };

/** Internal only. No provider I/O and no public route. All holds and the READY attempt commit together. */
export function createSafepayPendingOrderService(dependencies: {
  database: PaymentDatabase; getSettings: () => Promise<StoreSettings>;
  environment: "sandbox" | "production"; merchantAccountRef: string;
  reservationTtlMs: number; now?: () => Date;
}) {
  const { database, getSettings, environment, merchantAccountRef, reservationTtlMs } = dependencies;
  if (!["sandbox", "production"].includes(environment) || !merchantAccountRef || merchantAccountRef.length > 128 ||
      /[^\x21-\x7e]/.test(merchantAccountRef) ||
      !Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 1_000 || reservationTtlMs > 3_600_000)
    throw new Error("Invalid local reservation configuration.");
  const clock = dependencies.now ?? (() => new Date());
  return async (raw: unknown, context: TrustedPendingCheckout): Promise<PendingOrderResult> => {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || !context || !/^[A-Za-z0-9_-]{1,128}$/.test(context.cartId))
      return { kind: "blocked", code: "INVALID_REQUEST" };
    const contextOwner = (context as { owner?: { kind?: string } }).owner;
    if (contextOwner?.kind !== "USER") return { kind: "blocked", code: "NOT_ELIGIBLE" };
    let owner;
    try { owner = bindCheckoutOwner(context.owner); } catch { return { kind: "blocked", code: "NOT_ELIGIBLE" }; }
    const input = parsed.data;
    const idempotencyKey = "safepay:" + hash(["PENDING_ORDER_V1", owner.hash, input.idempotencyKey]);
    const fingerprint = hash(["CHECKOUT_SUBMISSION_V1", owner.hash, context.cartId, environment, merchantAccountRef,
      { ...input, idempotencyKey: undefined, couponCode: input.couponCode?.toUpperCase() || undefined }]);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Settings come from the existing trusted server service, never the request.
        const settings = await getSettings();
        const now = clock();
        const expiresAt = new Date(now.getTime() + reservationTtlMs);
        if (!Number.isFinite(expiresAt.getTime())) throw new PendingConflict("INVALID_REQUEST");
        return await database.$transaction(async tx => {
          const existing = await tx.order.findUnique({ where: { idempotencyKey }, include: { activePayment: true } });
          if (existing) {
            if (existing.checkoutOwnerHash !== owner.hash || existing.checkoutOwnerKind !== owner.kind ||
                existing.userId !== owner.userId || existing.checkoutFingerprint !== fingerprint ||
                existing.paymentFlowVersion !== 1 || !existing.activePayment)
              throw new PendingConflict("REQUEST_CONFLICT");
            if (existing.status !== "PENDING" || existing.checkoutClosedAt || !existing.reservationExpiresAt ||
                existing.reservationExpiresAt <= now) throw new PendingConflict("CHECKOUT_CLOSED");
            return { kind: "ready", orderId: existing.id, paymentId: existing.activePayment.id, reference: existing.reference, reused: true };
          }
          // Claim the cart version-gated before reading it (Phase 3, chunk
          // 3-final — Safepay cart lock Low): the previous plain updateMany
          // was not a lock — a second concurrent checkout for the same cart
          // could both proceed to reserve the same lines, and only the
          // deleteMany exact-snapshot guard at the end caught it. The
          // version claim fails the loser up front. Purchased lines are
          // removed in this transaction, while later additions remain intact.
          const cartHead = await tx.cart.findUnique({ where: { id: context.cartId },
            select: { id: true, userId: true, version: true } });
          if (!cartHead || cartHead.userId !== owner.userId) throw new PendingConflict("NOT_ELIGIBLE");
          const locked = await tx.cart.updateMany({ where: { id: context.cartId,
            userId: owner.userId, version: cartHead.version,
          }, data: { version: { increment: 1 }, updatedAt: now } });
          if (locked.count !== 1) throw new PendingConflict("BUSY");
          const cart = await tx.cart.findUniqueOrThrow({ where: { id: context.cartId }, include: {
            items: { orderBy: { productId: "asc" }, include: { variant: { include: { inventory: true } }, product: {
              include: { inventory: true, images: { orderBy: { sortOrder: "asc" }, take: 1 } },
            } } },
          } });
          if (!cart.items.length) throw new PendingConflict("EMPTY_CART");
          if (cart.items.length > 100) throw new PendingConflict("INVALID_REQUEST");
          // Unlike a preview, payment creation never silently drops unavailable lines.
          // A variant line prices and stocks against the VARIANT (Chunk 8 —
          // D12): its absolute override replaces the product price, its own
          // inventory row is the stock, and a gone/deactivated variant
          // rejects the whole checkout with OUT_OF_STOCK — never a silent
          // conversion to a no-variant line.
          const resolvedLines = cart.items.map(item => {
            const variant = item.variantId ? item.variant : null;
            const problem =
              item.variantId && !variant ? "variant-missing"
              : variant && !variant.isActive ? "variant-inactive"
              : null;
            const unitPrice = variant?.priceOverride ?? item.product.price;
            const inventoryRow = variant
              ? variant.inventory
              : item.product.inventory.find(r => r.variantId === null) ?? null;
            return { item, variant, unitPrice, inventoryRow, problem };
          });
          for (const line of resolvedLines) {
            const { item } = line;
            if (line.problem || item.product.status !== "PUBLISHED" || item.product.deletedAt || !line.inventoryRow ||
                !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
                line.unitPrice < 1 || !Number.isSafeInteger(line.unitPrice * item.quantity) ||
                line.inventoryRow.quantity < item.quantity) throw new PendingConflict("OUT_OF_STOCK");
          }
          const subtotal = resolvedLines.reduce((sum, line) => sum + line.unitPrice * line.item.quantity, 0);
          let coupon: Coupon | null = null;
          let discount: DiscountRule | null = null;
          let promotionId: string | null = null;
          let promotionTitle: string | null = null;
          if (input.couponCode) {
            const validation = validateCouponRecord(await tx.coupon.findUnique({ where: { code: input.couponCode.toUpperCase() } }), subtotal, now);
            if ("error" in validation) throw new PendingConflict("COUPON_UNAVAILABLE");
            coupon = validation.coupon; discount = validation.rule;
            // Per-user limit + first-order-only (D11/M-20), in-transaction:
            // the count is a pre-check; the reservedCount CAS below is the
            // atomic guard against a concurrent claim by the same user for
            // THIS coupon, and the first-order claim (Order.firstOrderCoupon
            // set at order.create below, migration 20261121000001) is the
            // atomic guard across DIFFERENT first-order-only coupons (R-1).
            if (await checkCouponUserEligibility(tx, coupon, owner.userId)) throw new PendingConflict("COUPON_UNAVAILABLE");
            const held = await tx.coupon.updateMany({ where: {
              id: coupon.id, version: coupon.version, usedCount: coupon.usedCount, reservedCount: coupon.reservedCount,
              maxUses: coupon.maxUses, isActive: true,
              AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
            }, data: { reservedCount: { increment: 1 }, version: { increment: 1 } } });
            if (held.count !== 1) throw new PendingConflict("COUPON_UNAVAILABLE");
          } else {
            // No coupon supplied: the best applicable automatic promotion
            // applies instead (D10) — it never stacks with a coupon.
            const promo = await evaluateAutomaticPromotion(tx, subtotal, now);
            if (promo) {
              discount = promo.rule;
              promotionId = promo.promotion.id;
              promotionTitle = promo.promotion.title;
            }
          }
          const pricing = computeOrderPricing({
            lines: resolvedLines.map(line => ({ productId: line.item.productId, unitPrice: line.unitPrice, quantity: line.item.quantity })),
            discount, delivery: { standardFee: settings.delivery_fee_standard, expressFee: settings.delivery_fee_express,
              freeThreshold: settings.free_delivery_threshold }, deliveryMethod: input.deliveryMethod,
            giftWrap: { enabled: settings.gift_wrap_enabled, charge: settings.gift_wrap_charge },
            giftWrapUnits: cart.items.reduce((sum, item) => sum + (item.giftWrap ? item.quantity : 0), 0),
          });
          if (Object.values(pricing).some(value => !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647))
            throw new PendingConflict("INVALID_REQUEST");
          if (pricing.total < 1) throw new PendingConflict("INVALID_REQUEST");
          const amountMinor = wholePkrToMinor(pricing.total);
          for (const line of resolvedLines) {
            const inventory = line.inventoryRow!;
            if ((await tx.inventory.updateMany({ where: {
              id: inventory.id, version: inventory.version, quantity: { gte: line.item.quantity },
            }, data: { quantity: { decrement: line.item.quantity }, version: { increment: 1 } } })).count !== 1)
              throw new PendingConflict("OUT_OF_STOCK");
          }
          const order = await tx.order.create({ data: {
            reference: generateOrderReference(), idempotencyKey, userId: owner.userId, isGuest: false,
            customerName: input.customer.name, customerEmail: input.customer.email, customerPhone: input.customer.phone,
            shipFullName: input.address.fullName, shipPhone: input.address.phone, shipLine1: input.address.line1,
            shipLine2: input.address.line2 || null, shipCity: input.address.city, shipProvince: input.address.province,
            shipPostalCode: input.address.postalCode || null, status: "PENDING", paymentMethod: "ONLINE", paymentStatus: "PENDING",
            ...pricing, deliveryMethod: input.deliveryMethod, giftWrapSelected: pricing.giftWrapCharge > 0,
            giftWrapMessage: input.giftWrapMessage || null, notes: input.notes || null,
            couponCode: coupon?.code ?? null, couponTitle: coupon ? discount?.title ?? null : null,
            // First-order claim (R-1, migration 20261121000001): the flag
            // is carried onto the order row, where the partial unique
            // index makes it the atomic guard — two concurrent first
            // orders with different first-order coupons cannot both
            // insert, even though both pre-checks read zero prior orders.
            firstOrderCoupon: coupon?.firstOrderOnly ?? false,
            promotionId, promotionTitle,
            paymentFlowVersion: 1, currency: "PKR", nextPaymentAttempt: 2,
            checkoutOwnerKind: owner.kind, checkoutOwnerHash: owner.hash, checkoutFingerprint: fingerprint,
            checkoutAccessExpiresAt: expiresAt, reservationExpiresAt: expiresAt, paymentReviewStatus: "CLEAR",
            items: { create: resolvedLines.map(line => ({ productId: line.item.productId,
              variantId: line.item.variantId, variantLabel: line.variant?.label ?? null, variantSku: line.variant?.sku ?? null,
              productName: line.item.product.name,
              productSlug: line.item.product.slug, imageUrl: line.item.product.images[0]?.url ?? null,
              unitPrice: line.unitPrice, quantity: line.item.quantity, lineTotal: line.unitPrice * line.item.quantity,
              giftWrap: line.item.giftWrap && settings.gift_wrap_enabled,
              inventoryReservation: { create: { inventoryId: line.inventoryRow!.id, quantity: line.item.quantity, heldAt: now } },
            })) },
            ...(coupon ? { couponReservation: { create: { couponId: coupon.id, heldAt: now } } } : {}),
          } });
          // Status history (M-6): the pending checkout itself is the first
          // timeline entry, written in the same transaction as the order.
          await recordOrderStatusHistory(tx, {
            orderId: order.id,
            status: "PENDING",
            actor: `customer:${owner.userId}`,
            note: "Payment checkout started",
          });
          // No READY attempt exists until every inventory/coupon hold has succeeded.
          const payment = await tx.payment.create({ data: { orderId: order.id, provider: "SAFEPAY", amount: pricing.total,
            status: "PENDING", currency: "PKR", expectedAmountMinor: amountMinor, attemptNumber: 1, attemptState: "READY",
            providerEnvironment: environment, merchantAccountRef, reconcileStatus: "NOT_STARTED" } });
          await tx.order.update({ where: { id: order.id }, data: { paymentOwnerOrderId: order.id, activePaymentId: payment.id, version: { increment: 1 } } });
          await tx.paymentEvidence.create({ data: { paymentId: payment.id, source: "LOCAL", operation: "RESERVE_CHECKOUT",
            validationStatus: "LOCAL_VALIDATED", decision: "RESERVATIONS_HELD", paymentVersion: 0, orderVersion: 1 } });
          // Compare each exact snapshot so a concurrent cart edit aborts rather than disappearing.
          for (const item of cart.items) {
            if ((await tx.cartItem.deleteMany({ where: { id: item.id, cartId: cart.id,
              quantity: item.quantity, giftWrap: item.giftWrap } })).count !== 1) throw new PendingConflict("BUSY");
          }
          if (clock() >= expiresAt) throw new PendingConflict("CHECKOUT_CLOSED");
          return { kind: "ready", orderId: order.id, paymentId: payment.id, reference: order.reference, reused: false };
        }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
      } catch (error) {
        if (error instanceof PendingConflict) return { kind: "blocked", code: error.code };
        // The one-redemption-per-user index (migration 20261120000006) is
        // the atomic guard: a racing second order for the same user +
        // coupon fails here even though its pre-check read zero prior
        // orders. It is deterministic — retrying would fail again — so it
        // must not fall through to the P2002 retry below.
        if (isPerUserCouponViolation(error)) return { kind: "blocked", code: "COUPON_UNAVAILABLE" };
        // The first-order claim (migration 20261121000001) is the atomic
        // guard: a racing second first order for the same user — with a
        // DIFFERENT first-order-only coupon, so the per-user index above
        // cannot see it — fails its order.create with P2002 even though
        // its pre-check read zero prior orders. It is deterministic —
        // retrying would fail again — so it must not fall through to the
        // P2002 retry below. The order is rejected with COUPON_UNAVAILABLE;
        // the coupon is not silently dropped and the order is not placed
        // without it.
        if (isFirstOrderClaimViolation(error)) return { kind: "blocked", code: "COUPON_UNAVAILABLE" };
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
        // No provider side effects exist here. Retrying an aborted local transaction is safe.
        if ((code === "P2034" || code === "P2002") && attempt < 2) continue;
        return { kind: "blocked", code: code === "P2034" || code === "P2028" || code === "P2024" ? "BUSY" : "PERSISTENCE_UNAVAILABLE" };
      }
    }
    return { kind: "blocked", code: "BUSY" };
  };
}
