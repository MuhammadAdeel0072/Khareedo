import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/sqlite-client";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import { loadSafepayConfig } from "@/lib/safepay/config";
import { createSafepayProvider, type HttpTransport } from "@/lib/safepay/provider";
import { createSafepayCheckoutService } from "@/services/safepay-checkout.service";
import { bindCheckoutOwner, createPrismaSafepayStore, type PaymentDatabase, type TrustedCheckoutOwner } from "@/services/safepay-attempt.store";

assertDisposableTestDatabase();
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const config = loadSafepayConfig({
  SAFEPAY_ENVIRONMENT: "sandbox", SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public", SAFEPAY_SECRET_KEY: "synthetic-secret",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-independent-return-key-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account", SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
});
const store = createPrismaSafepayStore(db as unknown as PaymentDatabase);
const orders: string[] = [], products: string[] = [], categories: string[] = [], users: string[] = [], coupons: string[] = [];
const serialize = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);

async function fixture(options: { coupon?: boolean } = {}) {
  const now = new Date();
  const user = await db.user.create({ data: { email: randomUUID() + "@example.invalid", emailVerified: now } });
  users.push(user.id);
  const owner: TrustedCheckoutOwner = { kind: "USER", userId: user.id };
  const binding = bindCheckoutOwner(owner);
  const category = await db.category.create({ data: { name: "Safepay synthetic " + randomUUID(), slug: randomUUID() } });
  categories.push(category.id);
  const product = await db.product.create({ data: {
    name: "Synthetic reserved product", slug: randomUUID(), categoryId: category.id, price: 1000,
    inventory: { create: { quantity: 4 } },
  }, include: { inventory: true } });
  products.push(product.id);
  const total = options.coupon ? 900 : 1000;
  const order = await db.$transaction(async tx => {
    const order = await tx.order.create({ data: {
      reference: "SFP-" + randomUUID(), idempotencyKey: randomUUID(), isGuest: false,
      user: { connect: { id: user.id } },
      customerName: "Synthetic", customerEmail: "synthetic@example.invalid", customerPhone: "03000000000",
      shipFullName: "Synthetic", shipPhone: "03000000000", shipLine1: "Synthetic", shipCity: "Test", shipProvince: "Test",
      paymentMethod: "ONLINE", status: "PENDING", paymentStatus: "PENDING", paymentFlowVersion: 1,
      nextPaymentAttempt: 2, currency: "PKR", subtotal: 1000, discountTotal: options.coupon ? 100 : 0, total,
      checkoutOwnerKind: binding.kind, checkoutOwnerHash: binding.hash, checkoutFingerprint: "a".repeat(64),
      checkoutAccessExpiresAt: new Date(now.getTime() + 600000), reservationExpiresAt: new Date(now.getTime() + 600000),
      items: { create: { productId: product.id, productName: product.name, productSlug: product.slug, quantity: 1, unitPrice: 1000, lineTotal: 1000 } },
      payments: { create: {
        provider: "SAFEPAY", amount: total, currency: "PKR", attemptNumber: 1, attemptState: "READY",
        providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account", expectedAmountMinor: BigInt(total * 100),
      } },
    }, include: { items: true, payments: true } });
    await tx.inventoryReservation.create({ data: {
      orderItemId: order.items[0].id, inventoryId: product.inventory!.id, quantity: 1,
    } });
    if (options.coupon) {
      const coupon = await tx.coupon.create({ data: {
        code: randomUUID(), type: "PERCENT", value: 10, maxUses: 5, reservedCount: 1,
      } });
      coupons.push(coupon.id);
      await tx.couponReservation.create({ data: { orderId: order.id, couponId: coupon.id } });
      await tx.order.update({ where: { id: order.id }, data: { couponCode: coupon.code } });
    }
    await tx.order.update({ where: { id: order.id }, data: { paymentOwnerOrderId: order.id, activePaymentId: order.payments[0].id } });
    return order;
  });
  orders.push(order.id);
  return { order, payment: order.payments[0], owner, product,
    request: { orderId: order.id, paymentId: order.payments[0].id, requestKey: randomUUID() } };
}

function goodTracker(init: RequestInit, change: Record<string, unknown> = {}) {
  const input = JSON.parse(init.body as string);
  return new Response(JSON.stringify({
    data: { tracker: {
      token: "synthetic-" + randomUUID(), environment: "sandbox", state: "TRACKER_STARTED",
      intent: "CYBERSOURCE", mode: "payment", entry_mode: "flex",
      purchase_totals: { quote_amount: { currency: "PKR", amount: input.amount } }, ...change,
    }, capabilities: { CYBERSOURCE: true } },
    status: { errors: [], message: "success" },
  }), { status: 201 });
}
function transport() {
  return vi.fn<HttpTransport>(async (url, init) =>
    url.pathname === "/order/payments/v3/" ? goodTracker(init) : new Response(JSON.stringify({ data: "synthetic-authentication" })));
}
function service(http: HttpTransport, customStore = store) {
  return createSafepayCheckoutService({ config, store: customStore, provider: createSafepayProvider(config, http) });
}

afterAll(async () => {
  await db.paymentEvidence.deleteMany({ where: { payment: { orderId: { in: orders } } } });
  await db.inventoryReservation.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
  await db.couponReservation.deleteMany({ where: { orderId: { in: orders } } });
  await db.order.updateMany({ where: { id: { in: orders } }, data: { activePaymentId: null, acceptedPaymentId: null, paymentOwnerOrderId: null } });
  await db.order.deleteMany({ where: { id: { in: orders } } });
  await db.product.deleteMany({ where: { id: { in: products } } });
  await db.category.deleteMany({ where: { id: { in: categories } } });
  await db.coupon.deleteMany({ where: { id: { in: coupons } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("Safepay session orchestration with mocked HTTP and real disposable persistence", () => {
  it("prepares hosted redirect for an authenticated customer's reserved order", async () => {
    const f = await fixture({ coupon: true }), http = transport();
    const result = await service(http)(f.request, f.owner);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected redirect");
    expect(new URL(result.redirect.location()).host).toBe("sandbox.api.getsafepay.com");
    expect(serialize(result)).not.toContain("synthetic-authentication");
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(payment).toMatchObject({ status: "PENDING", attemptState: "CHECKOUT_ISSUED", amount: 900 });
    expect(payment.trackerToken).toBeTruthy();
    expect(order).toMatchObject({ status: "PENDING", paymentStatus: "PENDING", total: 900 });
    expect((await db.inventory.findUniqueOrThrow({ where: { productId: f.product.id } })).quantity).toBe(4);
    expect(await db.coupon.findFirstOrThrow({ where: { id: { in: coupons }, reservations: { some: { orderId: order.id } } } }))
      .toMatchObject({ usedCount: 0, reservedCount: 1 });
    const evidence = await db.paymentEvidence.findMany({ where: { paymentId: payment.id } });
    expect(evidence).toHaveLength(4);
    expect(serialize(evidence)).not.toContain("synthetic-authentication");
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("replays a local request without creating a second tracker or token", async () => {
    const f = await fixture(), http = transport(), run = service(http);
    expect((await run(f.request, f.owner)).kind).toBe("ready");
    expect(await run(f.request, f.owner)).toEqual({ kind: "blocked", code: "ALREADY_ISSUED" });
    expect(await run({ ...f.request, requestKey: randomUUID() }, f.owner)).toMatchObject({ kind: "blocked", code: "REQUEST_CONFLICT" });
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("handles concurrent requests with one durable provider-creation claim", async () => {
    const f = await fixture();
    let dispatched!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const http = vi.fn<HttpTransport>(async (url, init) => {
      if (url.pathname === "/order/payments/v3/") { dispatched(); await gate; return goodTracker(init); }
      return new Response(JSON.stringify({ data: "synthetic-authentication" }));
    });
    const run = service(http), first = run(f.request, f.owner);
    await started;
    const second = await run(f.request, f.owner);
    expect(second).toMatchObject({ kind: "blocked", code: "CREATION_UNCERTAIN" });
    release(); expect((await first).kind).toBe("ready");
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("does not dispatch on a crashed prior creation claim", async () => {
    const f = await fixture(), http = transport();
    expect((await store.claim(f.request, bindCheckoutOwner(f.owner), config, new Date())).kind).toBe("claimed");
    expect(await service(http)(f.request, f.owner)).toMatchObject({ kind: "blocked", code: "CREATION_UNCERTAIN" });
    expect(http).not.toHaveBeenCalled();
  });
  it.each(["claimed", "issued"] as const)("blocks a replacement attempt when an older attempt was %s", async stage => {
    const f = await fixture(), http = transport();
    if (stage === "claimed") {
      expect((await store.claim(f.request, bindCheckoutOwner(f.owner), config, new Date())).kind).toBe("claimed");
    } else {
      expect((await service(http)(f.request, f.owner)).kind).toBe("ready");
    }
    const replacement = await db.payment.create({ data: {
      orderId: f.order.id, provider: "SAFEPAY", amount: 1000, currency: "PKR", attemptNumber: 2,
      attemptState: "READY", providerEnvironment: "sandbox", merchantAccountRef: "synthetic-account",
      expectedAmountMinor: BigInt(100000),
    } });
    await db.order.update({ where: { id: f.order.id }, data: { activePaymentId: replacement.id, version: { increment: 1 } } });
    expect(await service(http)({ ...f.request, paymentId: replacement.id }, f.owner))
      .toMatchObject({ kind: "blocked", code: "RESUME_BLOCKED" });
    expect(http).toHaveBeenCalledTimes(stage === "claimed" ? 0 : 2);
  });
  it("rejects a different owner without exposing or modifying the order", async () => {
    const f = await fixture(), other = await fixture(), http = transport();
    expect(await service(http)(f.request, other.owner))
      .toEqual({ kind: "blocked", code: "NOT_ELIGIBLE" });
    expect(http).not.toHaveBeenCalled();
  });
  it("does not recreate a tracker after an attempt state was reset but creation history remains", async () => {
    const f = await fixture(), http = transport();
    await db.payment.update({ where: { id: f.payment.id }, data: { creationStartedAt: new Date() } });
    expect(await service(http)(f.request, f.owner)).toMatchObject({ kind: "blocked", code: "RESUME_BLOCKED" });
    expect(http).not.toHaveBeenCalled();
  });
  it("rejects client price/owner/redirect injection before persistence or HTTP", async () => {
    const f = await fixture(), http = transport();
    expect(await service(http)({ ...f.request, amount: 1, redirect_url: "https://evil.invalid" }, f.owner))
      .toEqual({ kind: "blocked", code: "INVALID_REQUEST" });
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).attemptState).toBe("READY");
    expect(http).not.toHaveBeenCalled();
  });
  it.each(["expired", "released", "wrong-price", "missing-coupon-capacity"] as const)("rejects unsafe prepared state: %s", async kind => {
    const f = await fixture({ coupon: kind === "missing-coupon-capacity" }), http = transport();
    if (kind === "expired") await db.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
    if (kind === "released") await db.inventoryReservation.update({
      where: { orderItemId: f.order.items[0].id }, data: { state: "RELEASED", releasedAt: new Date() },
    });
    if (kind === "wrong-price") await db.payment.update({ where: { id: f.payment.id }, data: { expectedAmountMinor: BigInt(1) } });
    if (kind === "missing-coupon-capacity") {
      const held = await db.couponReservation.findUniqueOrThrow({ where: { orderId: f.order.id } });
      await db.coupon.update({ where: { id: held.couponId }, data: { reservedCount: 0 } });
    }
    expect(await service(http)(f.request, f.owner)).toMatchObject({ kind: "blocked", code: "NOT_ELIGIBLE" });
    expect(http).not.toHaveBeenCalled();
  });
  it.each([400, 500])("preserves ambiguous HTTP %s for review without retry or payment failure", async status => {
    const f = await fixture();
    const http = vi.fn<HttpTransport>(async () => new Response(JSON.stringify({ error: "synthetic raw provider diagnostic" }), { status }));
    const result = await service(http)(f.request, f.owner);
    expect(result).toMatchObject({ kind: "uncertain", code: "HTTP_ERROR" });
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
    expect(payment).toMatchObject({ status: "PENDING", attemptState: "CREATION_UNCERTAIN", reconcileStatus: "REVIEW_REQUIRED" });
    const evidence = await db.paymentEvidence.findFirstOrThrow({
      where: { paymentId: f.payment.id, decision: "REVIEW_REQUIRED" },
    });
    expect(JSON.parse(evidence.detailsJson ?? "{}")).toEqual({ httpStatus: status });
    expect(serialize(result)).not.toContain("provider diagnostic");
    await service(http)(f.request, f.owner);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("keeps network exceptions private and leaves an uncertain durable attempt", async () => {
    const f = await fixture(), http = vi.fn<HttpTransport>(async () => { throw new Error("synthetic-private-diagnostic"); });
    expect(await service(http)(f.request, f.owner)).toEqual({ kind: "uncertain", code: "NETWORK_ERROR" });
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).paymentStatus).toBe("PENDING");
  });
  it("persists a tracker timeout as uncertain and refuses a second POST", async () => {
    const f = await fixture(), http = vi.fn<HttpTransport>(() => new Promise(() => {}));
    const shortConfig = { ...config, timeoutMs: 100 };
    const run = createSafepayCheckoutService({
      config: shortConfig, store, provider: createSafepayProvider(shortConfig, http),
    });
    expect(await run(f.request, f.owner)).toEqual({ kind: "uncertain", code: "TIMEOUT" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } }))
      .toMatchObject({ attemptState: "CREATION_UNCERTAIN", reconcileStatus: "REVIEW_REQUIRED", status: "PENDING" });
    await run(f.request, f.owner);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("records a mismatched quote as unverified evidence without binding or issuing it", async () => {
    const f = await fixture(), http = vi.fn<HttpTransport>(async (_url, init) =>
      goodTracker(init, { purchase_totals: { quote_amount: { currency: "PKR", amount: 1 } } }));
    expect(await service(http)(f.request, f.owner)).toMatchObject({ kind: "uncertain", code: "TRACKER_MISMATCH" });
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).trackerToken).toBeNull();
    expect(await db.paymentEvidence.findFirstOrThrow({ where: { paymentId: f.payment.id, decision: "REVIEW_REQUIRED" } }))
      .toMatchObject({ observedQuoteMinor: BigInt(1), validationStatus: "UNVERIFIED" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("persists the tracker before requesting authentication and retains it if authentication fails", async () => {
    const f = await fixture();
    const http = vi.fn<HttpTransport>(async (url, init) => {
      if (url.pathname === "/order/payments/v3/") return goodTracker(init);
      expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).trackerToken).toBeTruthy();
      return new Response("synthetic-auth-error", { status: 403 });
    });
    expect(await service(http)(f.request, f.owner)).toMatchObject({ kind: "blocked", code: "AUTHENTICATION_UNAVAILABLE" });
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status).toBe("PENDING");
    const evidence = await db.paymentEvidence.findFirstOrThrow({
      where: { paymentId: f.payment.id, decision: "REVIEW_REQUIRED" },
    });
    expect(JSON.parse(evidence.detailsJson ?? "{}")).toEqual({ httpStatus: 403 });
    expect(evidence.detailsJson).not.toContain("synthetic-auth-error");
    await service(http)(f.request, f.owner); expect(http).toHaveBeenCalledTimes(2);
  });
  it("does not issue a redirect if the order expires during provider creation", async () => {
    const f = await fixture();
    const http = vi.fn<HttpTransport>(async (_url, init) => {
      await db.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
      return goodTracker(init);
    });
    expect(await service(http)(f.request, f.owner)).toMatchObject({ kind: "blocked", code: "CHECKOUT_NOT_ELIGIBLE" });
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).trackerToken).toBeTruthy();
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("does not redirect when expiry happens during authentication", async () => {
    const f = await fixture();
    const http = vi.fn<HttpTransport>(async (url, init) => {
      if (url.pathname === "/order/payments/v3/") return goodTracker(init);
      await db.order.update({ where: { id: f.order.id }, data: { checkoutClosedAt: new Date() } });
      return new Response(JSON.stringify({ data: "synthetic-authentication" }));
    });
    expect(await service(http)(f.request, f.owner)).toMatchObject({ kind: "blocked", code: "CHECKOUT_NOT_ELIGIBLE" });
  });
  it("never hands out a checkout URL when tracker persistence fails", async () => {
    const f = await fixture(), http = transport();
    const broken = { ...store, bindTracker: vi.fn(async () => null) };
    expect(await service(http, broken)(f.request, f.owner)).toEqual({ kind: "uncertain", code: "PERSISTENCE_UNCERTAIN" });
    expect(http).toHaveBeenCalledTimes(1);
    expect(await db.paymentEvidence.findFirstOrThrow({ where: { paymentId: f.payment.id, decision: "REVIEW_REQUIRED" } }))
      .toMatchObject({ reasonCode: "TRACKER_BIND_FAILED" });
  });
});
