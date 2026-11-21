// Postgres-only verification (Stream D, Phase 3 final completion).
// Runs ONLY against a disposable local PostgreSQL — never production.
// Run: PG_VERIFY_URL='postgresql://...' npx vitest run --config tests/postgres/vitest.pg.config.ts
// NOT included in `npm test` or `npm run test:db` (separate config + include).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { placeOrder } from "@/services/checkout.service";
import { customerCancelOrder } from "@/services/orders.service";
import { createPaymentRefundService } from "@/services/payment-refund.service";
import {
  checkCouponUserEligibility,
  isFirstOrderClaimViolation,
  isPerUserCouponViolation,
} from "@/lib/coupon-validation";

const PG_URL = process.env.PG_VERIFY_URL ?? "";
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
const customer = (email: string) => ({
  name: "PG Verify Buyer",
  email,
  phone: "+923001234567",
});
const address = () => ({
  fullName: "PG Verify Buyer",
  phone: "+923001234567",
  line1: "1 Verification Street",
  city: "Lahore",
  province: "Punjab" as const,
  postalCode: "54000",
});
const checkoutInput = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: uid("idem-pgverify-0123456789"),
  customer: customer(`pgv-${uid("c")}@example.test`),
  address: address(),
  deliveryMethod: "STANDARD" as const,
  paymentMethod: "COD" as const,
  ...over,
});

async function makeUser(email: string, role = "CUSTOMER") {
  return db.user.create({ data: { id: uid("pgv-u"), email, role } });
}
async function makeProduct(price: number, stock: number, name = "PGV Item") {
  const cat = await db.category.create({
    data: { id: uid("pgv-cat"), name: "PGV Cat", slug: uid("pgv-cat") },
  });
  const product = await db.product.create({
    data: {
      id: uid("pgv-p"),
      name,
      slug: uid("pgv-p"),
      categoryId: cat.id,
      price,
      status: "PUBLISHED",
    },
  });
  const inv = await db.inventory.create({
    data: { id: uid("pgv-inv"), productId: product.id, quantity: stock },
  });
  return { product, inv };
}
async function makeCartWith(userId: string, productId: string, qty: number) {
  const cart = await db.cart.create({ data: { id: uid("pgv-cart"), userId } });
  await db.cartItem.create({
    data: { id: uid("pgv-ci"), cartId: cart.id, productId, quantity: qty },
  });
  return cart;
}
async function makeCoupon(data: {
  code: string;
  type?: "PERCENT" | "FIXED";
  value?: number;
  maxUses?: number | null;
  firstOrderOnly?: boolean;
  usedCount?: number;
}) {
  return db.coupon.create({
    data: {
      id: uid("pgv-coupon"),
      // Codes are looked up upper-cased (reserveCoupon); store upper-case.
      code: data.code.toUpperCase(),
      type: data.type ?? "PERCENT",
      value: data.value ?? 10,
      maxUses: data.maxUses ?? null,
      firstOrderOnly: data.firstOrderOnly ?? false,
      usedCount: data.usedCount ?? 0,
    },
  });
}
function orderRow(over: Record<string, unknown>) {
  const id = uid("pgv-o");
  return {
    id,
    reference: `KH261120${id.slice(-10).toUpperCase()}`,
    idempotencyKey: uid("idem-pgverify-0123456789"),
    customerName: "PG Verify Buyer",
    customerEmail: "pgv@example.test",
    customerPhone: "+923001234567",
    shipFullName: "PG Verify Buyer",
    shipPhone: "+923001234567",
    shipLine1: "1 Verification Street",
    shipCity: "Lahore",
    shipProvince: "Punjab",
    status: "CONFIRMED",
    paymentMethod: "COD",
    paymentStatus: "PENDING",
    subtotal: 5000,
    total: 5200,
    ...over,
  };
}

beforeAll(async () => {
  expect(PG_URL).toContain("khareedo_pg_concurrency");
  // Sanity: we are on the disposable DB, and all 20 migrations applied
  // (18 Phase 3 + 20261121000000 product-index backfill +
  // 20261121000001 first-order coupon claim).
  const applied = await db.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT count(*) AS c FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
  );
  expect(Number(applied[0].c)).toBe(20);
});
afterAll(async () => {
  await db.$disconnect();
});

describe("constraints (real Postgres)", () => {
  it("partial unique index 20261120000006: second live order same user+coupon is rejected; cancel frees the slot; NULL coupon / NULL user never collide", async () => {
    const user = await makeUser(`pgv-c6-${uid("u")}@example.test`);
    const other = await makeUser(`pgv-c6-${uid("u")}@example.test`);
    const coupon = await makeCoupon({ code: uid("PGC6") });
    await db.order.create({ data: orderRow({ userId: user.id, couponCode: coupon.code }) });
    // Second live order, same user + coupon -> P2002.
    const dup = db.order.create({
      data: orderRow({ userId: user.id, couponCode: coupon.code }),
    });
    await expect(dup).rejects.toMatchObject({ code: "P2002" });
    // Same coupon, different user -> OK.
    await db.order.create({ data: orderRow({ userId: other.id, couponCode: coupon.code }) });
    // NULL couponCode rows never collide (same user, twice).
    await db.order.create({ data: orderRow({ userId: user.id, couponCode: null }) });
    await db.order.create({ data: orderRow({ userId: user.id, couponCode: null }) });
    // NULL userId (guest) rows never collide (same coupon, twice).
    await db.order.create({ data: orderRow({ userId: null, isGuest: true, couponCode: coupon.code }) });
    await db.order.create({ data: orderRow({ userId: null, isGuest: true, couponCode: coupon.code }) });
    // Cancel frees the slot: cancel the live order, then a new live order works.
    const live = await db.order.findFirstOrThrow({
      where: { userId: user.id, couponCode: coupon.code, status: { not: "CANCELLED" } },
    });
    await db.order.update({ where: { id: live.id }, data: { status: "CANCELLED" } });
    const again = await db.order.create({
      data: orderRow({ userId: user.id, couponCode: coupon.code }),
    });
    expect(again.status).toBe("CONFIRMED");
  });

  it("variant indexes: duplicate (product, variant) and duplicate null-variant inventory rows rejected; distinct variants OK; standalone variantId unique enforced", async () => {
    const { product } = await makeProduct(3000, 5, "PGV Variant Item");
    const v1 = await db.productVariant.create({
      data: { id: uid("pgv-v"), productId: product.id, label: "Size: M", sku: uid("PGV-SKU-M") },
    });
    const v2 = await db.productVariant.create({
      data: { id: uid("pgv-v"), productId: product.id, label: "Size: L", sku: uid("PGV-SKU-L") },
    });
    // The product-level row already exists (makeProduct). A second null-variant row -> P2002.
    await expect(
      db.inventory.create({ data: { id: uid("pgv-inv"), productId: product.id, quantity: 1 } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // One row per variant: two rows for v1 -> P2002; v1 and v2 distinct -> OK.
    await db.inventory.create({
      data: { id: uid("pgv-inv"), productId: product.id, variantId: v1.id, quantity: 3 },
    });
    await expect(
      db.inventory.create({
        data: { id: uid("pgv-inv"), productId: product.id, variantId: v1.id, quantity: 2 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await db.inventory.create({
      data: { id: uid("pgv-inv"), productId: product.id, variantId: v2.id, quantity: 2 },
    });
    // Standalone variantId unique (schema @unique, added to migration 20261120000003):
    // the same variant under a DIFFERENT productId must be rejected.
    const { product: product2 } = await makeProduct(4000, 1, "PGV Other Item");
    await expect(
      db.inventory.create({
        data: { id: uid("pgv-inv"), productId: product2.id, variantId: v1.id, quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // CartItem null-variant uniqueness: two no-variant lines, same cart+product -> P2002.
    const user = await makeUser(`pgv-cv-${uid("u")}@example.test`);
    const cart = await makeCartWith(user.id, product.id, 1);
    await expect(
      db.cartItem.create({
        data: { id: uid("pgv-ci"), cartId: cart.id, productId: product.id, quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("Review @@unique([userId, productId]) is enforced", async () => {
    const user = await makeUser(`pgv-rv-${uid("u")}@example.test`);
    const { product } = await makeProduct(2000, 3, "PGV Review Item");
    await db.review.create({
      data: { id: uid("pgv-r"), productId: product.id, userId: user.id, rating: 5 },
    });
    await expect(
      db.review.create({
        data: { id: uid("pgv-r"), productId: product.id, userId: user.id, rating: 4 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("Inventory CHECK (quantity >= 0): negative write rejected; Cart.version defaults to 0", async () => {
    const { product, inv } = await makeProduct(1000, 5, "PGV Check Item");
    // NOTE: Prisma 6.19.3 does NOT map a CHECK violation to a P-code; it
    // surfaces PrismaClientUnknownRequestError wrapping Postgres 23514.
    // Assert on the constraint name / SQLSTATE instead.
    await expect(
      db.inventory.update({ where: { id: inv.id }, data: { quantity: -1 } }),
    ).rejects.toThrow(/23514|Inventory_quantity_check/);
    await expect(
      db.inventory.create({
        data: { id: uid("pgv-inv"), productId: product.id, quantity: -5 },
      }),
    ).rejects.toThrow(/23514|Inventory_quantity_check/);
    // quantity is unchanged after the rejected writes.
    expect((await db.inventory.findUniqueOrThrow({ where: { id: inv.id } })).quantity).toBe(5);
    const user = await makeUser(`pgv-ck-${uid("u")}@example.test`);
    const cart = await db.cart.create({ data: { id: uid("pgv-cart"), userId: user.id } });
    expect(cart.version).toBe(0);
  });

  it("Prisma rejects null inside a compound-unique where (documented caveat); findFirst is the working lookup", async () => {
    const { product } = await makeProduct(1000, 5, "PGV Null Lookup");
    // findUnique on (productId, variantId) with variantId null throws in Prisma 6.19.3.
    await expect(
      // @ts-expect-error intentional: null in a compound-unique where
      db.inventory.findUnique({ where: { productId_variantId: { productId: product.id, variantId: null } } }),
    ).rejects.toThrow();
    const row = await db.inventory.findFirst({
      where: { productId: product.id, variantId: null },
    });
    expect(row?.productId).toBe(product.id);
  });
});

describe("concurrency (real Postgres, real services)", () => {
  it("inventory race: two concurrent checkouts of the last unit -> exactly one order, stock never negative", async () => {
    const { product } = await makeProduct(5000, 1, "PGV Last Unit");
    const users = await Promise.all([
      makeUser(`pgv-ir1-${uid("u")}@example.test`),
      makeUser(`pgv-ir2-${uid("u")}@example.test`),
    ]);
    for (const u of users) await makeCartWith(u.id, product.id, 1);
    const results = await Promise.allSettled(
      users.map((u) => placeOrder(checkoutInput(), u.id)),
    );
    const ok = results.filter(
      (r) => r.status === "fulfilled" && (r.value as { ok?: boolean }).ok === true,
    );
    expect(ok).toHaveLength(1);
    const failed = results.filter((r) => r.status !== "fulfilled" || (r.value as { ok?: boolean }).ok !== true);
    expect(failed).toHaveLength(1);
    const inv = await db.inventory.findFirstOrThrow({ where: { productId: product.id } });
    expect(inv.quantity).toBe(0);
    expect(inv.quantity).toBeGreaterThanOrEqual(0);
  });

  it("same-cart concurrent checkout: exactly one order proceeds", async () => {
    const { product } = await makeProduct(5000, 10, "PGV Same Cart");
    const user = await makeUser(`pgv-sc-${uid("u")}@example.test`);
    await makeCartWith(user.id, product.id, 2);
    const results = await Promise.allSettled([
      placeOrder(checkoutInput(), user.id),
      placeOrder(checkoutInput(), user.id),
    ]);
    const ok = results.filter(
      (r) => r.status === "fulfilled" && (r.value as { ok?: boolean }).ok === true,
    );
    expect(ok).toHaveLength(1);
    const orders = await db.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);
    const inv = await db.inventory.findFirstOrThrow({ where: { productId: product.id } });
    expect(inv.quantity).toBe(8); // exactly one decrement of 2
  });

  it("coupon race, same user: concurrent orders with the same coupon -> exactly one, loser is a per-user violation (P2002)", async () => {
    const user = await makeUser(`pgv-cr-${uid("u")}@example.test`);
    const coupon = await makeCoupon({ code: uid("PGCR") });
    // Two concurrent checkouts: BOTH eligibility pre-checks run before either
    // order commits (both read 0 prior redemptions), then both insert: the
    // partial unique index must reject exactly one with P2002.
    const [errA, errB] = await Promise.all([
      checkCouponUserEligibility(db, coupon as never, user.id),
      checkCouponUserEligibility(db, coupon as never, user.id),
    ]);
    expect(errA).toBeNull();
    expect(errB).toBeNull();
    const attempt = async () => {
      try {
        const created = await db.order.create({
          data: orderRow({ userId: user.id, couponCode: coupon.code }),
        });
        return { kind: "created", id: created.id } as const;
      } catch (e) {
        return { kind: "thrown", violation: isPerUserCouponViolation(e), code: (e as { code?: string }).code } as const;
      }
    };
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const created = [a, b].filter((r) => r.kind === "created");
    const violations = [a, b].filter((r) => r.kind === "thrown" && (r as { violation?: boolean }).violation === true);
    expect(created).toHaveLength(1);
    expect(violations).toHaveLength(1);
  });

  it("coupon race, two users, one remaining use (maxUses=1): exactly one checkout wins via placeOrder", async () => {
    const coupon = await makeCoupon({ code: uid("PGCU"), maxUses: 1 });
    const { product } = await makeProduct(5000, 10, "PGV One Use");
    const users = await Promise.all([
      makeUser(`pgv-cu1-${uid("u")}@example.test`),
      makeUser(`pgv-cu2-${uid("u")}@example.test`),
    ]);
    for (const u of users) await makeCartWith(u.id, product.id, 1);
    const results = await Promise.allSettled(
      users.map((u) => placeOrder(checkoutInput({ couponCode: coupon.code }), u.id)),
    );
    const ok = results.filter(
      (r) => r.status === "fulfilled" && (r.value as { ok?: boolean }).ok === true,
    );
    expect(ok).toHaveLength(1);
    const refreshed = await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(refreshed.usedCount).toBe(1);
  });

  it("first-order-only race (R-1, CLOSED by the claim index): two concurrent first orders with different first-order coupons -> exactly one commits, loser is a first-order-claim violation (P2002)", async () => {
    const user = await makeUser(`pgv-fo-${uid("u")}@example.test`);
    const couponA = await makeCoupon({ code: uid("PGFOA"), firstOrderOnly: true });
    const couponB = await makeCoupon({ code: uid("PGFOB"), firstOrderOnly: true });
    // Both eligibility pre-checks run concurrently, before either order
    // exists: both must pass (0 prior orders each).
    const [errA, errB] = await Promise.all([
      checkCouponUserEligibility(db, couponA as never, user.id),
      checkCouponUserEligibility(db, couponB as never, user.id),
    ]);
    expect(errA).toBeNull();
    expect(errB).toBeNull();
    // The services set firstOrderCoupon: true on the order row at creation;
    // the partial unique index Order_userId_first_order_coupon_active_idx
    // then rejects the second live claim with P2002. (Each coupon is used
    // once, so the per-coupon partial index does not fire — the claim
    // index is the guard that closes this race.)
    const attempt = async (coupon: typeof couponA) => {
      try {
        const created = await db.order.create({
          data: orderRow({ userId: user.id, couponCode: coupon.code, firstOrderCoupon: true }),
        });
        return { kind: "created", id: created.id } as const;
      } catch (e) {
        return { kind: "thrown", violation: isFirstOrderClaimViolation(e), code: (e as { code?: string }).code } as const;
      }
    };
    const [a, b] = await Promise.all([attempt(couponA), attempt(couponB)]);
    const created = [a, b].filter((r) => r.kind === "created");
    const violations = [a, b].filter((r) => r.kind === "thrown" && (r as { violation?: boolean }).violation === true);
    expect(created).toHaveLength(1);
    expect(violations).toHaveLength(1);
    const orders = await db.order.findMany({
      where: { userId: user.id, status: { not: "CANCELLED" } },
    });
    expect(orders).toHaveLength(1);
  });

  it("customer cancellation: double-cancel is idempotent and restocks exactly once", async () => {
    const { product, inv } = await makeProduct(5000, 4, "PGV Cancel Item");
    const user = await makeUser(`pgv-cc-${uid("u")}@example.test`);
    await makeCartWith(user.id, product.id, 2);
    const placed = await placeOrder(checkoutInput(), user.id);
    expect(placed.ok).toBe(true);
    expect((await db.inventory.findUniqueOrThrow({ where: { id: inv.id } })).quantity).toBe(2);
    const orderId = (placed as { ok: true; orderId: string }).orderId;
    const [first, second] = await Promise.all([
      customerCancelOrder(orderId, user.id, "changed my mind"),
      customerCancelOrder(orderId, user.id, "changed my mind"),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Exactly one of the two concurrent calls reports already-cancelled
    // (whichever lost the version-gated claim); both succeed.
    const alreadyCount = [first, second].filter(
      (r) => (r as { alreadyCancelled?: boolean }).alreadyCancelled === true,
    ).length;
    expect(alreadyCount).toBe(1);
    const fresh = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(fresh.status).toBe("CANCELLED");
    expect(fresh.paymentStatus).toBe("CANCELLED");
    expect(fresh.cancelReason).toBe("changed my mind");
    // Exactly one restock of 2 units: 4 - 2 + 2 = 4.
    expect((await db.inventory.findUniqueOrThrow({ where: { id: inv.id } })).quantity).toBe(4);
    const history = await db.orderStatusHistory.findMany({ where: { orderId, status: "CANCELLED" } });
    expect(history).toHaveLength(1);
  });

  it("refund: in-window identical requests park exactly one REVIEW_REQUIRED row; 24h+ backdated capture creates the refund; idempotency-key replay returns the same row", async () => {
    const user = await makeUser(`pgv-rf-${uid("u")}@example.test`);
    const merchantRef = "pgv-test-ref";
    const mkManaged = async (paidVerifiedAt: Date) => {
      const orderId = uid("pgv-mo");
      const paymentId = uid("pgv-mp");
      // Order <-> Payment FKs are circular (Payment.orderId -> Order, and
      // Order.acceptedPaymentId -> Payment(orderId, id)): create the order
      // without the payment pointers, create the payment, then link.
      await db.order.create({
        data: orderRow({
          id: orderId,
          userId: user.id,
          status: "CONFIRMED",
          paymentMethod: "ONLINE",
          paymentStatus: "PAID",
          paymentFlowVersion: 1,
          currency: "PKR",
          // Order_managed_checkout_check requires all of these when
          // paymentFlowVersion is set.
          nextPaymentAttempt: 1,
          checkoutOwnerKind: "USER",
          checkoutOwnerHash: "pgv-test-owner-hash",
          checkoutFingerprint: "pgv-test-fingerprint",
          checkoutAccessExpiresAt: new Date(Date.now() + 3600 * 1000),
          reservationExpiresAt: new Date(Date.now() + 900 * 1000),
        }),
      });
      await db.payment.create({
        data: {
          id: paymentId,
          orderId,
          provider: "SAFEPAY",
          amount: 5200,
          status: "PAID",
          providerEnvironment: "sandbox",
          merchantAccountRef: merchantRef,
          trackerToken: uid("trk-pgv"),
          // Payment_tracker_binding_check + Payment_managed_attempt_check:
          // a bound tracker needs trackerIdentityKey + attemptNumber, and a
          // set attemptNumber needs attemptState + the SAFEPAY binding.
          trackerIdentityKey: uid("trk-id-pgv"),
          attemptNumber: 1,
          attemptState: "PAID",
          currency: "PKR",
          paidVerifiedAt,
          expectedAmountMinor: BigInt(520000),
          capturedAmountMinor: BigInt(520000),
          refundedAmountMinor: BigInt(0),
        },
      });
      await db.order.update({
        where: { id: orderId },
        data: { paymentOwnerOrderId: orderId, acceptedPaymentId: paymentId },
      });
      return { orderId, paymentId };
    };
    const refundService = createPaymentRefundService(db as never, null, {
      environment: "sandbox",
      merchantAccountRef: merchantRef,
      pollDelayMs: 1000,
      maxConfirmationAttempts: 3,
      submitGraceMs: 1000,
      reversalWindowMs: 24 * 3600 * 1000,
      cardRefundWindowMs: 90 * 24 * 3600 * 1000,
    });

    // (a) In-window: paid 1h ago -> parked. Two concurrent identical requests -> 1 row.
    const recent = await mkManaged(new Date(Date.now() - 3600 * 1000));
    const [r1, r2] = await Promise.all([
      refundService.requestRefund({ paymentId: recent.paymentId, requestedByUserId: user.id }),
      refundService.requestRefund({ paymentId: recent.paymentId, requestedByUserId: user.id }),
    ]);
    // Exactly one call creates the parked row ("review_required"); the other
    // finds it via the parkForReview dedup and returns "existing" — both
    // reference the same row. Either order is valid under concurrency.
    const kinds = [r1.kind, r2.kind].sort();
    expect(kinds).toEqual(["existing", "review_required"]);
    expect(
      (r1 as { refundId?: string }).refundId,
    ).toBe((r2 as { refundId?: string }).refundId);
    const parked = await db.paymentRefund.findMany({
      where: { paymentId: recent.paymentId, status: "REVIEW_REQUIRED" },
    });
    expect(parked).toHaveLength(1);
    expect(parked[0].reviewReason).toBe("REFUND_WINDOW_REVERSAL_24H");

    // (b) Window release: backdate paidVerifiedAt 25h (method: UPDATE the row;
    // the service clocks the window off paidVerifiedAt, not a capture event).
    const old = await mkManaged(new Date(Date.now() - 25 * 3600 * 1000));
    const idemKey = uid("idem-key-pgverify-");
    const created = await refundService.requestRefund({
      paymentId: old.paymentId,
      requestedByUserId: user.id,
      idempotencyKey: idemKey,
    });
    expect(created.kind).toBe("created");
    const refundId = (created as { kind: "created"; refundId: string }).refundId;
    // No provider is wired in this test (null): submission is honestly
    // uncertain, row stays SUBMITTING — no provider call, no real money.
    expect((created as { submission?: { kind?: string } }).submission?.kind).toBe("uncertain");
    const row = await db.paymentRefund.findUniqueOrThrow({ where: { id: refundId } });
    expect(row.status).toBe("SUBMITTING");
    // Idempotency-key replay (same key) returns the SAME row, no second row.
    const replay = await refundService.requestRefund({
      paymentId: old.paymentId,
      requestedByUserId: user.id,
      idempotencyKey: idemKey,
    });
    expect(replay.kind).toBe("existing");
    expect((replay as { refundId?: string }).refundId).toBe(refundId);
    expect(
      await db.paymentRefund.count({ where: { paymentId: old.paymentId } }),
    ).toBe(1);

    // (c) Settlement dedup predicate (documented quirk): a SUCCEEDED refund
    // with the same (paymentId, amount, providerRefundedAt) matches the
    // previouslySettled lookup, so a second identical observation is
    // recorded as already-settled rather than settling twice.
    const settled = await db.paymentRefund.findUniqueOrThrow({ where: { id: refundId } });
    await db.paymentRefund.update({
      where: { id: refundId },
      data: { status: "SUCCEEDED", providerRefundedAt: new Date("2026-11-20T10:00:00.000Z") },
    });
    const match = await db.paymentRefund.findFirst({
      where: {
        paymentId: old.paymentId,
        status: "SUCCEEDED",
        amountMinor: settled.amountMinor,
        providerRefundedAt: new Date("2026-11-20T10:00:00.000Z"),
      },
      select: { id: true },
    });
    expect(match?.id).toBe(refundId);
  });
});
