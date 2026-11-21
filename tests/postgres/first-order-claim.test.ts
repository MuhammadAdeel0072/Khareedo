// Postgres-only verification — first-order-only coupon claim (R-1, D11).
// Runs ONLY against a disposable local PostgreSQL — never production.
// Run: PG_VERIFY_URL='postgresql://pgverify:pgverify-disposable-only@localhost:55435/khareedo_pg_firstorder' \
//   npx vitest run --config tests/postgres/vitest.pg.config.ts tests/postgres/first-order-claim.test.ts
// NOT included in `npm test` or `npm run test:db` (separate config + include).
//
// Proves, under real Postgres concurrency, what the SQLite harness cannot:
// two concurrent first orders with DIFFERENT first-order-only coupons for
// one user cannot both commit — the claim partial unique index
// (migration 20261121000001) rejects exactly one with P2002, detected by
// isFirstOrderClaimViolation. Same-user concurrent placeOrder calls are
// serialised by the cart row lock (the loser finds the cart consumed), so
// the concurrency proof is at the order-creation level — the same
// methodology as the per-user-index proof in pg-verify.test.ts — while
// the service-level tests below prove both checkout paths set the claim
// flag and reject a second first-order coupon sequentially.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { placeOrder } from "@/services/checkout.service";
import { customerCancelOrder } from "@/services/orders.service";
import {
  checkCouponUserEligibility,
  isFirstOrderClaimViolation,
} from "@/lib/coupon-validation";

const PG_URL = process.env.PG_VERIFY_URL ?? "";
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;
const customer = (email: string) => ({
  name: "PG FirstOrder Buyer",
  email,
  phone: "+923001234567",
});
const address = () => ({
  fullName: "PG FirstOrder Buyer",
  phone: "+923001234567",
  line1: "1 Claim Street",
  city: "Lahore",
  province: "Punjab" as const,
  postalCode: "54000",
});
const checkoutInput = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: uid("idem-pgfo-0123456789"),
  customer: customer(`pgf-${uid("c")}@example.test`),
  address: address(),
  deliveryMethod: "STANDARD" as const,
  paymentMethod: "COD" as const,
  ...over,
});

async function makeUser(email: string, role = "CUSTOMER") {
  return db.user.create({ data: { id: uid("pgf-u"), email, role } });
}
async function makeProduct(price: number, stock: number, name = "PGF Item") {
  const cat = await db.category.create({
    data: { id: uid("pgf-cat"), name: "PGF Cat", slug: uid("pgf-cat") },
  });
  const product = await db.product.create({
    data: {
      id: uid("pgf-p"),
      name,
      slug: uid("pgf-p"),
      categoryId: cat.id,
      price,
      status: "PUBLISHED",
    },
  });
  const inv = await db.inventory.create({
    data: { id: uid("pgf-inv"), productId: product.id, quantity: stock },
  });
  return { product, inv };
}
async function makeCartWith(userId: string, productId: string, qty: number) {
  // Cart.userId is @unique: refill the user's single cart row instead of
  // creating a second one (mirrors seedUserCart in the SQLite suites).
  const cart = await db.cart.upsert({
    where: { userId },
    update: {},
    create: { id: uid("pgf-cart"), userId },
  });
  await db.cartItem.deleteMany({ where: { cartId: cart.id } });
  await db.cartItem.create({
    data: { id: uid("pgf-ci"), cartId: cart.id, productId, quantity: qty },
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
      id: uid("pgf-coupon"),
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
  const id = uid("pgf-o");
  return {
    id,
    reference: `KH261121${id.slice(-10).toUpperCase()}`,
    idempotencyKey: uid("idem-pgfo-0123456789"),
    customerName: "PG FirstOrder Buyer",
    customerEmail: "pgf@example.test",
    customerPhone: "+923001234567",
    shipFullName: "PG FirstOrder Buyer",
    shipPhone: "+923001234567",
    shipLine1: "1 Claim Street",
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
  // Hard guard: this file only ever runs against the disposable
  // first-order-claim database on the disposable cluster port — never
  // the pg-tunnel on :5432 (live Supabase) or any other database.
  expect(PG_URL).toContain("khareedo_pg_firstorder");
  expect(PG_URL).toMatch(/localhost:55435|127\.0\.0\.1:55435/);
  expect(PG_URL).not.toContain(":5432");
  // Sanity: the claim migration applied — column + partial unique index exist.
  const columns = await db.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT count(*) AS c FROM information_schema.columns WHERE table_name = 'Order' AND column_name = 'firstOrderCoupon'`,
  );
  expect(Number(columns[0].c)).toBe(1);
  const indexes = await db.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT count(*) AS c FROM pg_indexes WHERE indexname = 'Order_userId_first_order_coupon_active_idx'`,
  );
  expect(Number(indexes[0].c)).toBe(1);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("first-order claim (real Postgres, real services)", () => {
  it("two concurrent first orders with different first-order-only coupons cannot both commit", async () => {
    const user = await makeUser(`pgf-race-${uid("u")}@example.test`);
    const couponA = await makeCoupon({ code: uid("PGFOA"), firstOrderOnly: true });
    const couponB = await makeCoupon({ code: uid("PGFOB"), firstOrderOnly: true });
    // Both eligibility pre-checks run concurrently, before either order
    // exists: both must pass (0 prior orders each) — the count cannot
    // serialize this race.
    const [errA, errB] = await Promise.all([
      checkCouponUserEligibility(db, couponA as never, user.id),
      checkCouponUserEligibility(db, couponB as never, user.id),
    ]);
    expect(errA).toBeNull();
    expect(errB).toBeNull();
    const attempt = async (coupon: typeof couponA) => {
      try {
        const created = await db.order.create({
          data: orderRow({ userId: user.id, couponCode: coupon.code, firstOrderCoupon: true }),
        });
        return { kind: "created", id: created.id } as const;
      } catch (e) {
        return {
          kind: "thrown",
          violation: isFirstOrderClaimViolation(e),
          code: (e as { code?: string }).code,
        } as const;
      }
    };
    // Exactly one insert commits: the claim partial unique index rejects
    // the other with P2002. (Each coupon is used once, so the per-coupon
    // partial index does not fire — only the claim index can decide this.)
    const [a, b] = await Promise.all([attempt(couponA), attempt(couponB)]);
    const created = [a, b].filter((r) => r.kind === "created");
    const violations = [a, b].filter((r) => r.kind === "thrown" && (r as { violation?: boolean }).violation === true);
    expect(created).toHaveLength(1);
    expect(violations).toHaveLength(1);
    expect((violations[0] as { code?: string }).code).toBe("P2002");
    const live = await db.order.findMany({
      where: { userId: user.id, firstOrderCoupon: true, status: { not: "CANCELLED" } },
    });
    expect(live).toHaveLength(1);
  });

  it("a cancelled claim frees the index: a replacement first-order order commits", async () => {
    const user = await makeUser(`pgf-free-${uid("u")}@example.test`);
    const couponA = await makeCoupon({ code: uid("PGFFA"), firstOrderOnly: true });
    const couponB = await makeCoupon({ code: uid("PGFFB"), firstOrderOnly: true });
    const first = await db.order.create({
      data: orderRow({ userId: user.id, couponCode: couponA.code, firstOrderCoupon: true }),
    });
    await db.order.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    const replacement = await db.order.create({
      data: orderRow({ userId: user.id, couponCode: couponB.code, firstOrderCoupon: true }),
    });
    expect(replacement).toMatchObject({ couponCode: couponB.code, firstOrderCoupon: true });
  });

  it("COD placeOrder sets the claim flag and rejects a second first-order coupon", async () => {
    const { product } = await makeProduct(5000, 10, "PGF Claim Item");
    const user = await makeUser(`pgf-cod-${uid("u")}@example.test`);
    const couponA = await makeCoupon({ code: uid("PGFCA"), firstOrderOnly: true });
    const couponB = await makeCoupon({ code: uid("PGFCB"), firstOrderOnly: true });
    await makeCartWith(user.id, product.id, 1);
    const first = await placeOrder(checkoutInput({ couponCode: couponA.code }), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first order to place");
    const firstRow = await db.order.findUniqueOrThrow({ where: { id: first.orderId } });
    expect(firstRow.firstOrderCoupon).toBe(true);
    expect(firstRow.couponCode).toBe(couponA.code);

    await makeCartWith(user.id, product.id, 1);
    const attempted = await placeOrder(checkoutInput({ couponCode: couponB.code }), user.id);
    expect(attempted).toMatchObject({
      ok: false,
      code: "COUPON_UNAVAILABLE",
      error: "This coupon is only valid for your first order.",
    });
    expect(await db.order.count({ where: { userId: user.id, status: { not: "CANCELLED" } } })).toBe(1);
  });

  it("COD cancel frees the claim: a different first-order coupon then places", async () => {
    const { product } = await makeProduct(5000, 10, "PGF Cancel Item");
    const user = await makeUser(`pgf-cc-${uid("u")}@example.test`);
    const couponA = await makeCoupon({ code: uid("PGFCCA"), firstOrderOnly: true });
    const couponB = await makeCoupon({ code: uid("PGFCCB"), firstOrderOnly: true });
    await makeCartWith(user.id, product.id, 1);
    const first = await placeOrder(checkoutInput({ couponCode: couponA.code }), user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first order to place");
    const cancel = await customerCancelOrder(first.orderId, user.id, "changed my mind");
    expect(cancel.ok).toBe(true);

    await makeCartWith(user.id, product.id, 1);
    const retry = await placeOrder(checkoutInput({ couponCode: couponB.code }), user.id);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("Expected post-cancel first-order coupon to place");
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: retry.orderId } })).firstOrderCoupon,
    ).toBe(true);
  });
});
