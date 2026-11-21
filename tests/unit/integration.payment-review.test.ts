// Integration test — payment review, refunds UI data, coupon release and
// order ownership (Phase 3, Chunk 2 partial). Run with:
// npm run test:db
//
// Covers M-4 (getOrderById is scoped to the requesting user at the service
// layer), H-10 (admin-cancel of a COD order restores the coupon useCount via
// a compare-and-set decrement, idempotently), H-13 (admin resolution of a
// REQUIRED payment-review hold: release after verified non-capture, consume
// after verified capture, refusals without evidence), and the review-queue
// listing used by both the API route and the admin page. All against the real
// Prisma layer on a disposable SQLite database; no provider I/O.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import type { Coupon } from "../../generated/postgres-client";

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    }),
  };
});
import { db } from "@/lib/db";
import { createSafepayPendingOrderService } from "@/services/safepay-pending-order.service";
import { createSafepayReservationService } from "@/services/safepay-reservations.service";
import type { PaymentDatabase } from "@/services/safepay-attempt.store";
import { trackerIdentity } from "@/lib/payments/evidence-contract";
import { placeOrder } from "@/services/checkout.service";
import type { PlaceOrderInput } from "@/lib/validation";
import { adminUpdateOrderStatus, getOrderById } from "@/services/orders.service";
import { validateCoupon } from "@/services/promotions.service";
import { DEFAULT_SETTINGS } from "@/services/settings.service";
import * as settingsService from "@/services/settings.service";
import {
  countPaymentReviewCases,
  createPaymentReviewService,
  listPaymentReviewCases,
} from "@/services/payment-review.service";

assertDisposableTestDatabase();
const database = db as unknown as PaymentDatabase;
const productIds: string[] = [];
const categoryIds: string[] = [];
const couponIds: string[] = [];
const cartIds: string[] = [];
const userIds: string[] = [];
const settings = { ...DEFAULT_SETTINGS, delivery_fee_standard: 200, gift_wrap_charge: 150 };

const codInput = (couponCode?: string): PlaceOrderInput => ({
  idempotencyKey: randomUUID(),
  paymentMethod: "COD" as const,
  deliveryMethod: "STANDARD" as const,
  customer: { name: "Synthetic Buyer", email: "synthetic@example.invalid", phone: "03001234567" },
  address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" },
  ...(couponCode ? { couponCode } : {}),
});

async function seedProduct(stock = 5) {
  const category = await db.category.create({
    data: { name: "ReviewCat-" + randomUUID(), slug: "reviewcat-" + randomUUID(), isActive: true },
  });
  categoryIds.push(category.id);
  const product = await db.product.create({
    data: {
      name: "Synthetic review item",
      slug: "review-" + randomUUID(),
      categoryId: category.id,
      price: 1000,
      status: "PUBLISHED",
      inventory: { create: { quantity: stock } },
    },
  });
  productIds.push(product.id);
  return product;
}

async function seedCoupon(maxUses = 1): Promise<Coupon> {
  const coupon = await db.coupon.create({
    data: {
      code: "R" + randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase(),
      type: "PERCENT",
      value: 10,
      maxUses,
    },
  });
  couponIds.push(coupon.id);
  return coupon;
}

async function seedUserWithCart(productId: string, quantity = 1) {
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid" } });
  userIds.push(user.id);
  const cart = await db.cart.create({
    data: { userId: user.id, items: { create: [{ productId, quantity }] } },
  });
  cartIds.push(cart.id);
  return { user, cart };
}

/** A CONFIRMED COD order placed through the real checkout (coupon reserved via usedCount). */
async function seedCodOrder(opts: { coupon?: boolean; quantity?: number } = {}) {
  const product = await seedProduct(5);
  const coupon = opts.coupon ? await seedCoupon(1) : null;
  const { user } = await seedUserWithCart(product.id, opts.quantity ?? 1);
  vi.spyOn(settingsService, "getSettings").mockResolvedValue(settings);
  const placed = await placeOrder(codInput(coupon?.code), user.id);
  if (!placed.ok) throw new Error("Synthetic COD order failed: " + placed.error);
  return { product, coupon, user, orderId: placed.orderId };
}

async function seedRequiredOrder(opts: { coupon?: boolean } = {}) {
  const product = await seedProduct(5);
  const coupon = opts.coupon ? await seedCoupon(10) : null;
  const { user, cart } = await seedUserWithCart(product.id, 2);
  const pending = createSafepayPendingOrderService({
    database,
    getSettings: async () => settings,
    environment: "sandbox",
    merchantAccountRef: "synthetic-account",
    reservationTtlMs: 600_000,
    now: () => new Date(),
  });
  const prepared = await pending(
    {
      idempotencyKey: randomUUID(),
      paymentMethod: "ONLINE",
      deliveryMethod: "STANDARD",
      customer: { name: "Synthetic Buyer", email: "synthetic@example.invalid", phone: "03001234567" },
      address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" },
      ...(coupon ? { couponCode: coupon.code } : {}),
    },
    { cartId: cart.id, owner: { kind: "USER", userId: user.id } }
  );
  if (prepared.kind !== "ready") throw new Error("Synthetic pending order failed: " + prepared.code);
  const token = "synthetic-tracker-" + randomUUID();
  // Production binds trackerToken and trackerIdentityKey together
  // (safepay-attempt.store bindTracker); the disposable SQLite harness
  // rejects setting the token alone, so mirror the production pair.
  await db.payment.update({
    where: { id: prepared.paymentId },
    data: {
      trackerToken: token,
      trackerIdentityKey: trackerIdentity({ provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account", trackerToken: token }),
      creationStartedAt: new Date(),
      trackerBoundAt: new Date(),
      attemptState: "CHECKOUT_ISSUED",
      reconcileStatus: "PENDING",
    },
  });
  const closed = await createSafepayReservationService(database, () => new Date()).cancel(
    prepared.orderId,
    { kind: "USER", userId: user.id }
  );
  if (!closed.ok || closed.outcome !== "REVIEW_REQUIRED") {
    throw new Error("Synthetic close did not require review: " + JSON.stringify(closed));
  }
  return { ...prepared, product, coupon, user, token };
}

async function seedEvidence(
  paymentId: string,
  opts: { source?: string; capturedMinor?: bigint | null; reasonCode?: string } = {}
) {
  return db.paymentEvidence.create({
    data: {
      paymentId,
      source: opts.source ?? "RECONCILIATION",
      operation: "INVESTIGATION",
      validationStatus: "AUTHENTICATED",
      decision: "REVIEW_REQUIRED",
      reasonCode: opts.reasonCode ?? "PROVIDER_FINALITY_UNVERIFIED",
      observedCapturedMinor: opts.capturedMinor ?? null,
      paymentVersion: 1,
      orderVersion: 1,
    },
  });
}

async function orderState(orderId: string) {
  return db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      payments: true,
      items: { include: { inventoryReservation: true } },
      couponReservation: true,
    },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const orders = (
    await db.order.findMany({
      where: { items: { some: { productId: { in: productIds } } } },
      select: { id: true },
    })
  ).map((o) => o.id);
  // Chunk 7-final: status changes/cancels now enqueue customer emails in
  // the outbox. Remove this file's rows so later suites' small outbox
  // sweeps are not starved by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: "synthetic@example.invalid" } });
  await db.adminAuditLog.deleteMany({ where: { targetId: { in: orders } } });
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await db.couponReservation.deleteMany({ where: { orderId: { in: orders } } });
  await db.order.updateMany({
    where: { id: { in: orders } },
    data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null },
  });
  await db.order.deleteMany({ where: { id: { in: orders } } });
  await db.cart.deleteMany({ where: { id: { in: cartIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds } } });
  await db.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("M-4: customer order detail is scoped to the owning user", () => {
  it("loads the owner's order, and returns null for another user or no user", async () => {
    const first = await seedCodOrder();
    const second = await seedCodOrder();
    const own = await getOrderById(first.orderId, first.user.id);
    expect(own?.id).toBe(first.orderId);
    expect(await getOrderById(first.orderId, second.user.id)).toBeNull();
    expect(await getOrderById(first.orderId, "")).toBeNull();
    expect(await getOrderById(randomUUID(), first.user.id)).toBeNull();
  });
});

describe("H-10: admin-cancel of a COD order restores the coupon use", () => {
  it("restores usedCount and the coupon is usable again", async () => {
    const f = await seedCodOrder({ coupon: true });
    const coupon = f.coupon!;
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
    const result = await adminUpdateOrderStatus(f.orderId, "CANCELLED");
    expect(result).toEqual({ ok: true });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
    // The restored use is really usable again: validation passes.
    expect(await validateCoupon(coupon.code, 1000)).not.toHaveProperty("error");
  });

  it("changes nothing when the cancelled order used no coupon", async () => {
    const f = await seedCodOrder({ coupon: true });
    const untouched = await seedCoupon(5);
    const before = await db.coupon.findUniqueOrThrow({ where: { id: untouched.id } });
    const plain = await seedCodOrder();
    const result = await adminUpdateOrderStatus(plain.orderId, "CANCELLED");
    expect(result).toEqual({ ok: true });
    const after = await db.coupon.findUniqueOrThrow({ where: { id: untouched.id } });
    expect(after.usedCount).toBe(before.usedCount);
    // The other order's coupon is untouched too.
    expect((await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).usedCount).toBe(1);
  });

  it("cannot double-restore: a second cancel is refused and the count stays restored", async () => {
    const f = await seedCodOrder({ coupon: true });
    expect(await adminUpdateOrderStatus(f.orderId, "CANCELLED")).toEqual({ ok: true });
    const second = await adminUpdateOrderStatus(f.orderId, "CANCELLED");
    expect(second.ok).toBe(false);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).usedCount).toBe(0);
  });
});

describe("H-13: resolving a REQUIRED payment-review hold", () => {
  it("refuses a release before any investigation evidence exists", async () => {
    const f = await seedRequiredOrder();
    const service = createPaymentReviewService(database as never);
    const result = await service.resolvePaymentReviewHold(f.orderId, "NOT_CAPTURED");
    expect(result).toEqual({ ok: false, code: "INVESTIGATION_REQUIRED" });
    expect((await orderState(f.orderId)).paymentReviewStatus).toBe("REQUIRED");
  });

  it("releases coupon + inventory holds after verified non-capture, and is idempotent", async () => {
    const f = await seedRequiredOrder({ coupon: true });
    await seedEvidence(f.paymentId);
    const service = createPaymentReviewService(database as never);
    // The audit row's adminUserId is an FK to User: use a real admin user.
    const admin = await db.user.create({
      data: { email: randomUUID() + "@example.invalid", role: "ADMIN" },
    });
    userIds.push(admin.id);
    const audit = { adminUserId: admin.id };
    const result = await service.resolvePaymentReviewHold(f.orderId, "NOT_CAPTURED", audit);
    expect(result).toEqual({ ok: true, outcome: "RELEASED" });
    const state = await orderState(f.orderId);
    expect(state.paymentReviewStatus).toBe("CLEAR");
    expect(state.status).toBe("CANCELLED");
    // Finality established (verified non-capture): the unpaid payment is
    // CANCELLED (D2/M-7), not left PENDING on an already-cancelled order.
    expect(state.paymentStatus).toBe("CANCELLED");
    expect(state.payments[0].status).toBe("CANCELLED");
    expect(state.couponReservation?.state).toBe("RELEASED");
    expect((await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } })).reservedCount).toBe(0);
    expect(state.items[0].inventoryReservation?.state).toBe("RELEASED");
    expect((await db.inventory.findFirstOrThrow({ where: { productId: f.product.id, variantId: null } })).quantity).toBe(5);
    expect(state.payments[0].attemptState).toBe("CLOSED");
    expect(state.payments[0].reconcileStatus).toBe("NOT_REQUIRED");
    // Audit row recorded atomically with the resolution.
    const audits = await db.adminAuditLog.findMany({ where: { targetId: f.orderId } });
    expect(audits.some((a) => a.action === "admin.payment.review_hold_resolved")).toBe(true);
    // Repeat resolution is refused — no double release.
    expect(await service.resolvePaymentReviewHold(f.orderId, "NOT_CAPTURED")).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect((await db.inventory.findFirstOrThrow({ where: { productId: f.product.id, variantId: null } })).quantity).toBe(5);
  });

  it("refuses a release when capture evidence exists", async () => {
    const f = await seedRequiredOrder();
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    await seedEvidence(f.paymentId, { capturedMinor: payment.expectedAmountMinor! });
    const service = createPaymentReviewService(database as never);
    expect(await service.resolvePaymentReviewHold(f.orderId, "NOT_CAPTURED")).toEqual({
      ok: false,
      code: "CAPTURE_EVIDENCE_PRESENT",
    });
  });

  it("consumes holds and accepts the payment after verified capture", async () => {
    const f = await seedRequiredOrder({ coupon: true });
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    await seedEvidence(f.paymentId, {
      capturedMinor: payment.expectedAmountMinor!,
      reasonCode: "LATE_CAPTURE",
    });
    const service = createPaymentReviewService(database as never);
    const result = await service.resolvePaymentReviewHold(f.orderId, "CAPTURED");
    expect(result).toEqual({ ok: true, outcome: "CONSUMED", paymentId: f.paymentId });
    const state = await orderState(f.orderId);
    expect(state.paymentReviewStatus).toBe("CLEAR");
    expect(state.status).toBe("CANCELLED");
    expect(state.paymentStatus).toBe("PAID");
    expect(state.acceptedPaymentId).toBe(f.paymentId);
    expect(state.couponReservation?.state).toBe("COMMITTED");
    const coupon = await db.coupon.findUniqueOrThrow({ where: { id: f.coupon!.id } });
    expect(coupon.reservedCount).toBe(0);
    expect(coupon.usedCount).toBe(1);
    expect(state.items[0].inventoryReservation?.state).toBe("CONSUMED");
    // Stock stays reduced: it was already reduced when the hold was placed.
    expect((await db.inventory.findFirstOrThrow({ where: { productId: f.product.id, variantId: null } })).quantity).toBe(3);
    const paid = state.payments[0];
    expect(paid.status).toBe("PAID");
    expect(paid.attemptState).toBe("SETTLED");
    expect(paid.reconcileStatus).toBe("VERIFIED");
    expect(paid.capturedAmountMinor).toBe(payment.expectedAmountMinor);
    expect(paid.paidVerifiedAt).not.toBeNull();
  });

  it("refuses a capture resolution without capture evidence, and on amount mismatch", async () => {
    const f = await seedRequiredOrder();
    await seedEvidence(f.paymentId);
    const service = createPaymentReviewService(database as never);
    expect(await service.resolvePaymentReviewHold(f.orderId, "CAPTURED")).toEqual({
      ok: false,
      code: "CAPTURE_EVIDENCE_REQUIRED",
    });
    const g = await seedRequiredOrder();
    const payment = await db.payment.findUniqueOrThrow({ where: { id: g.paymentId } });
    await seedEvidence(g.paymentId, {
      capturedMinor: payment.expectedAmountMinor! - BigInt(100),
      reasonCode: "LATE_CAPTURE",
    });
    expect(await service.resolvePaymentReviewHold(g.orderId, "CAPTURED")).toEqual({
      ok: false,
      code: "CAPTURE_AMOUNT_MISMATCH",
    });
  });

  it("refuses to resolve orders that are not REQUIRED closed orders", async () => {
    const f = await seedCodOrder();
    const service = createPaymentReviewService(database as never);
    expect(await service.resolvePaymentReviewHold(f.orderId, "NOT_CAPTURED")).toEqual({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    // Stage 3 audit, L-3: a nonexistent order is ORDER_NOT_FOUND (→ 404
    // at the route), not NOT_ELIGIBLE.
    expect(await service.resolvePaymentReviewHold(randomUUID(), "NOT_CAPTURED")).toEqual({
      ok: false,
      code: "ORDER_NOT_FOUND",
    });
  });
});

describe("H-16: review-queue listing", () => {
  it("lists REQUIRED cases with investigation and capture flags", async () => {
    const f = await seedRequiredOrder();
    const before = await listPaymentReviewCases(database as never);
    const row = before.find((c) => c.orderId === f.orderId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      reference: expect.any(String),
      orderStatus: "CANCELLED",
      paymentStatus: "PENDING",
      reviewReason: "PROVIDER_FINALITY_UNVERIFIED",
      investigated: false,
      captureEvidence: false,
    });
    await seedEvidence(f.paymentId);
    const after = await listPaymentReviewCases(database as never);
    expect(after.find((c) => c.orderId === f.orderId)).toMatchObject({
      investigated: true,
      captureEvidence: false,
    });
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    await seedEvidence(f.paymentId, { capturedMinor: payment.expectedAmountMinor! });
    const captured = await listPaymentReviewCases(database as never);
    expect(captured.find((c) => c.orderId === f.orderId)).toMatchObject({
      investigated: true,
      captureEvidence: true,
    });
  });

  it("countPaymentReviewCases agrees with the queue listing (M-32)", async () => {
    const before = await countPaymentReviewCases(database as never);
    const f = await seedRequiredOrder();
    expect(await countPaymentReviewCases(database as never)).toBe(before + 1);
    const listed = await listPaymentReviewCases(database as never);
    expect(listed.some((c) => c.orderId === f.orderId)).toBe(true);
  });
});
