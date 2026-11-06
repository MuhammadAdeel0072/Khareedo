import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  placeOrder: vi.fn(),
  quoteOrder: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/services/checkout.service", () => ({
  placeOrder: mocks.placeOrder,
  quoteOrder: mocks.quoteOrder,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  clientIp: () => "synthetic-client",
}));
vi.mock("@/lib/performance-timing", () => ({
  withPerformanceTiming: (_name: string, operation: () => Promise<Response>) => operation(),
}));

import { POST as place } from "@/app/api/checkout/place/route";
import { POST as quote } from "@/app/api/checkout/quote/route";

const checkoutBody = {
  idempotencyKey: "authenticated-checkout-request",
  customer: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "03001234567" },
  address: {
    fullName: "Synthetic Buyer", phone: "03001234567", line1: "Synthetic Street",
    city: "Lahore", province: "Punjab",
  },
  deliveryMethod: "STANDARD",
  paymentMethod: "COD",
};

function request(path: string, body: unknown = checkoutBody) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("checkout API authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.rateLimit.mockReturnValue({ ok: true });
    mocks.placeOrder.mockResolvedValue({ ok: true, reference: "KH-TEST", orderId: "order-test" });
    mocks.quoteOrder.mockResolvedValue({ total: 1000 });
  });

  it("rejects unauthenticated COD placement before order creation, including forged owner fields", async () => {
    const response = await place(request("/api/checkout/place", {
      ...checkoutBody, userId: "forged-customer", guestToken: "forged-guest-token",
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(mocks.placeOrder).not.toHaveBeenCalled();
  });

  it("derives order ownership from the verified session, not request fields", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "session-customer" });
    const response = await place(request("/api/checkout/place", {
      ...checkoutBody, userId: "forged-customer", guestToken: "forged-guest-token",
    }));

    expect(response.status).toBe(200);
    expect(mocks.placeOrder).toHaveBeenCalledWith(expect.not.objectContaining({
      userId: "forged-customer",
      guestToken: "forged-guest-token",
    }), "session-customer");
  });

  it("rejects unauthenticated quote requests", async () => {
    const response = await quote(request("/api/checkout/quote", {}));

    expect(response.status).toBe(401);
    expect(mocks.quoteOrder).not.toHaveBeenCalled();
  });
});
