import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TestSafepayConfigurationError extends Error {}
  return {
    TestSafepayConfigurationError,
    config: {
      environment: "sandbox",
      merchantAccountRef: "synthetic-account",
      siteOrigin: "https://shop.example.invalid",
      signReturnState: () => Buffer.from("synthetic-stable-guest-token".padEnd(32, "x")),
    },
    loadSafepayConfig: vi.fn(),
    getSessionUser: vi.fn(),
    resolveCart: vi.fn(),
    cookies: vi.fn(),
    getSettings: vi.fn(),
    pendingOrder: vi.fn(),
    checkout: vi.fn(),
    provider: { createTracker: vi.fn(), authenticate: vi.fn() },
    pendingServiceFactory: vi.fn(),
    checkoutServiceFactory: vi.fn(),
    createProvider: vi.fn(),
    createStore: vi.fn(),
    events: [] as string[],
  };
});

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/db", () => ({ db: { $transaction: vi.fn() } }));
vi.mock("@/lib/auth-guard", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/services/cart.service", () => ({ resolveCart: mocks.resolveCart }));
vi.mock("@/services/settings.service", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/safepay/config", () => ({
  loadSafepayConfig: mocks.loadSafepayConfig,
  SafepayConfigurationError: mocks.TestSafepayConfigurationError,
}));
vi.mock("@/lib/safepay/provider", () => ({ createSafepayProvider: mocks.createProvider }));
vi.mock("@/services/safepay-attempt.store", () => ({ createPrismaSafepayStore: mocks.createStore }));
vi.mock("@/services/safepay-pending-order.service", () => ({
  createSafepayPendingOrderService: mocks.pendingServiceFactory,
}));
vi.mock("@/services/safepay-checkout.service", () => ({
  createSafepayCheckoutService: mocks.checkoutServiceFactory,
}));

import { POST } from "@/app/api/checkout/safepay/session/route";

const body = {
  idempotencyKey: "sandbox-checkout-request-0001",
  customer: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "03001234567" },
  address: { fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street 1", city: "Lahore", province: "Punjab" },
  deliveryMethod: "STANDARD",
  paymentMethod: "ONLINE",
};

function request(data: unknown = body) {
  return new Request("http://localhost/api/checkout/safepay/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": crypto.randomUUID() },
    body: JSON.stringify(data),
  });
}

describe("Safepay checkout session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.config.environment = "sandbox";
    mocks.loadSafepayConfig.mockReturnValue(mocks.config);
    mocks.getSessionUser.mockResolvedValue({ id: "user-1" });
    mocks.resolveCart.mockResolvedValue({ id: "cart-1", isGuest: false });
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    mocks.getSettings.mockResolvedValue({});
    mocks.pendingOrder.mockImplementation(async () => {
      mocks.events.push("pending");
      return { kind: "ready", orderId: "order-1", paymentId: "payment-1", reference: "KH-TEST", reused: false };
    });
    mocks.checkout.mockImplementation(async () => {
      mocks.events.push("tracker-and-auth");
      return { kind: "ready", state: "synthetic-signed-state",
        redirect: { location: () => "https://sandbox.api.getsafepay.com/embedded/?tracker=synthetic" } };
    });
    mocks.pendingServiceFactory.mockReturnValue(mocks.pendingOrder);
    mocks.checkoutServiceFactory.mockReturnValue(mocks.checkout);
    mocks.createProvider.mockReturnValue(mocks.provider);
    mocks.createStore.mockReturnValue({});
  });

  it("creates the pending order before returning a sandbox hosted checkout URL", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, reference: "KH-TEST",
      redirectUrl: "https://sandbox.api.getsafepay.com/embedded/?tracker=synthetic",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBe(
      "khd_sfpay_return=synthetic-signed-state; Path=/; HttpOnly; SameSite=Lax; Max-Age=900; Secure",
    );
    expect(mocks.events).toEqual(["pending", "tracker-and-auth"]);
    expect(mocks.pendingOrder).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethod: "ONLINE", idempotencyKey: body.idempotencyKey }),
      expect.objectContaining({ owner: { kind: "USER", userId: "user-1" }, cartId: "cart-1" }),
    );
    expect(mocks.checkout).toHaveBeenCalledWith({
      orderId: "order-1", paymentId: "payment-1", requestKey: body.idempotencyKey,
    }, { kind: "USER", userId: "user-1" });
  });

  it("rejects unauthenticated checkout before loading configuration or creating payment state", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(mocks.loadSafepayConfig).not.toHaveBeenCalled();
    expect(mocks.resolveCart).not.toHaveBeenCalled();
    expect(mocks.pendingOrder).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it("rejects forged customer and guest ownership fields", async () => {
    const response = await POST(request({ ...body, userId: "forged-customer", guestToken: "forged-guest" }));

    expect(response.status).toBe(422);
    expect(mocks.pendingOrder).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("rejects invalid input without creating an order or provider session", async () => {
    const response = await POST(request({ ...body, paymentMethod: "COD" }));
    expect(response.status).toBe(422);
    expect(mocks.pendingOrder).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("blocks production before creating an order", async () => {
    mocks.config.environment = "production";
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SAFEPAY_SANDBOX_ONLY" });
    expect(mocks.pendingOrder).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("does not create another tracker for an already-issued duplicate request", async () => {
    mocks.checkout.mockResolvedValue({ kind: "blocked", code: "ALREADY_ISSUED" });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.pendingOrder).toHaveBeenCalledTimes(1);
    expect(mocks.checkout).toHaveBeenCalledTimes(1);
  });

  it("does not start Safepay when pending order creation fails", async () => {
    mocks.pendingOrder.mockResolvedValue({ kind: "blocked", code: "OUT_OF_STOCK" });
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it("does not return a hosted URL when provider setup is uncertain", async () => {
    mocks.checkout.mockResolvedValue({ kind: "uncertain", code: "NETWORK_ERROR" });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("redirectUrl");
  });
});
