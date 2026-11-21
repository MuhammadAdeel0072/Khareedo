import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/sqlite-client";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import { loadSafepayConfig } from "@/lib/safepay/config";
import { signReturnState } from "@/lib/safepay/redirect";
import { bindCheckoutOwner, type TrustedCheckoutOwner } from "@/services/safepay-attempt.store";
import { resolveSafepayCancel } from "@/services/safepay-cancel.service";

assertDisposableTestDatabase();
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const config = loadSafepayConfig({
  SAFEPAY_ENVIRONMENT: "sandbox", SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public", SAFEPAY_SECRET_KEY: "synthetic-secret",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-independent-return-key-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account", SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
});
const orders: string[] = [], products: string[] = [], categories: string[] = [], users: string[] = [];

async function fixture(options: { tracker?: boolean } = {}) {
  const now = new Date();
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid", emailVerified: now } });
  users.push(user.id);
  const owner: TrustedCheckoutOwner = { kind: "USER", userId: user.id };
  const binding = bindCheckoutOwner(owner);
  const category = await db.category.create({ data: { name: "Safepay cancel synthetic " + randomUUID(), slug: randomUUID() } });
  categories.push(category.id);
  const product = await db.product.create({ data: {
    name: "Synthetic reserved product", slug: randomUUID(), categoryId: category.id, price: 1000,
    inventory: { create: { quantity: 4 } },
  }, include: { inventory: true } });
  products.push(product.id);
  const trackerToken = options.tracker ? "synthetic-tracker-" + randomUUID() : null;
  // The test harness requires a tracker identity key whenever a tracker is
  // bound (same rule bindTracker enforces in production).
  const trackerIdentityKey = trackerToken ? createHash("sha256").update(JSON.stringify(
    ["SAFEPAY", "sandbox", "synthetic-account", trackerToken])).digest("hex") : null;
  const order = await db.$transaction(async tx => {
    const order = await tx.order.create({ data: {
      reference: "SFP-" + randomUUID(), idempotencyKey: randomUUID(), isGuest: false,
      user: { connect: { id: user.id } },
      customerName: "Synthetic", customerEmail: "synthetic@example.invalid", customerPhone: "03000000000",
      shipFullName: "Synthetic", shipPhone: "03000000000", shipLine1: "Synthetic", shipCity: "Test", shipProvince: "Test",
      paymentMethod: "ONLINE", status: "PENDING", paymentStatus: "PENDING", paymentFlowVersion: 1,
      nextPaymentAttempt: 2, currency: "PKR", subtotal: 1000, discountTotal: 0, total: 1000,
      checkoutOwnerKind: binding.kind, checkoutOwnerHash: binding.hash, checkoutFingerprint: "a".repeat(64),
      checkoutAccessExpiresAt: new Date(now.getTime() + 600000), reservationExpiresAt: new Date(now.getTime() + 600000),
      items: { create: { productId: product.id, productName: product.name, productSlug: product.slug, quantity: 1, unitPrice: 1000, lineTotal: 1000 } },
      payments: { create: {
        provider: "SAFEPAY", amount: 1000, currency: "PKR", attemptNumber: 1,
        attemptState: options.tracker ? "TRACKER_CREATED" : "READY",
        providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account", expectedAmountMinor: BigInt(100000),
        ...(trackerToken ? { trackerToken, trackerIdentityKey, creationStartedAt: now } : {}),
      } },
    }, include: { items: true, payments: true } });
    const inventoryId = product.inventory.find((r) => r.variantId === null)!.id;
    await tx.inventoryReservation.create({ data: {
      orderItemId: order.items[0].id, inventoryId, quantity: 1,
    } });
    // Mirror the real pending-order flow: the hold deducts stock until released.
    await tx.inventory.update({ where: { id: inventoryId }, data: { quantity: 3 } });
    await tx.order.update({ where: { id: order.id }, data: { paymentOwnerOrderId: order.id, activePaymentId: order.payments[0].id } });
    return order;
  });
  orders.push(order.id);
  const state = signReturnState(config, { orderId: order.id, paymentId: order.payments[0].id,
    ownerHash: binding.hash, expiresAt: Date.now() + 600_000 });
  return { order, payment: order.payments[0], owner, product, state, trackerToken };
}

async function orderState(orderId: string) {
  return db.order.findUniqueOrThrow({ where: { id: orderId },
    include: { items: { include: { inventoryReservation: true } }, payments: true } });
}
async function stock(productId: string) {
  return (await db.inventory.findFirstOrThrow({ where: { productId, variantId: null } })).quantity;
}

afterAll(async () => {
  // Chunk 7-final: the cancel page enqueues a cancellation email. Remove
  // this file's rows so later suites' small outbox sweeps are not starved
  // by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: "synthetic@example.invalid" } });
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await db.order.updateMany({ where: { id: { in: orders } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orders } } });
  await db.product.deleteMany({ where: { id: { in: products } } });
  await db.category.deleteMany({ where: { id: { in: categories } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("Safepay cancel return (Phase 3, chunk 3-final — H-2)", () => {
  it("releases an unstarted reservation exactly once; a second visit is already_closed", async () => {
    const f = await fixture();
    expect(await stock(f.product.id)).toBe(3);
    const first = await resolveSafepayCancel({ config, database: db as never, query: { state: f.state }, owner: f.owner });
    expect(first).toMatchObject({ kind: "released", reference: f.order.reference });
    const order = await orderState(f.order.id);
    expect(order).toMatchObject({ status: "CANCELLED", paymentStatus: "CANCELLED", checkoutCloseReason: "CANCELLED" });
    expect(order.items[0].inventoryReservation).toMatchObject({ state: "RELEASED" });
    expect(order.payments[0]).toMatchObject({ status: "CANCELLED", attemptState: "CLOSED" });
    expect(await stock(f.product.id)).toBe(4);
    const second = await resolveSafepayCancel({ config, database: db as never, query: { state: f.state }, owner: f.owner });
    expect(second).toMatchObject({ kind: "already_closed", reference: f.order.reference });
    expect(await stock(f.product.id)).toBe(4);
  });
  it("holds a tracker-bearing cancel for review instead of releasing a possibly-paid payment", async () => {
    const f = await fixture({ tracker: true });
    const result = await resolveSafepayCancel({ config, database: db as never, query: { state: f.state }, owner: f.owner });
    expect(result).toMatchObject({ kind: "review_required", reference: f.order.reference });
    const order = await orderState(f.order.id);
    expect(order).toMatchObject({ status: "CANCELLED", paymentStatus: "PENDING", paymentReviewStatus: "REQUIRED" });
    expect(order.items[0].inventoryReservation).toMatchObject({ state: "HELD" });
    expect(order.payments[0]).toMatchObject({ status: "PENDING", reconcileStatus: "REVIEW_REQUIRED" });
    expect(await stock(f.product.id)).toBe(3);
  });
  it("resolves by tracker echo when the provider drops the state", async () => {
    const f = await fixture({ tracker: true });
    const result = await resolveSafepayCancel({ config, database: db as never, query: { tracker: f.trackerToken! }, owner: f.owner });
    expect(result).toMatchObject({ kind: "review_required", reference: f.order.reference });
  });
  it("rejects a different owner without touching the reservation", async () => {
    const f = await fixture(), other = await fixture();
    const result = await resolveSafepayCancel({ config, database: db as never, query: { state: f.state }, owner: other.owner });
    expect(result).toEqual({ kind: "invalid" });
    const order = await orderState(f.order.id);
    expect(order.status).toBe("PENDING");
    expect(order.items[0].inventoryReservation?.state).toBe("HELD");
    expect(await stock(f.product.id)).toBe(3);
  });
  it("rejects an expired state, an empty return, and a malformed state", async () => {
    const f = await fixture();
    const expired = await resolveSafepayCancel({ config, database: db as never, query: { state: f.state },
      owner: f.owner, now: Date.now() + 900_000 });
    expect(expired).toEqual({ kind: "invalid" });
    expect(await resolveSafepayCancel({ config, database: db as never, query: {}, owner: f.owner }))
      .toEqual({ kind: "invalid" });
    expect(await resolveSafepayCancel({ config, database: db as never, query: { state: "not-a-state" }, owner: f.owner }))
      .toEqual({ kind: "invalid" });
    expect((await orderState(f.order.id)).status).toBe("PENDING");
  });
});
