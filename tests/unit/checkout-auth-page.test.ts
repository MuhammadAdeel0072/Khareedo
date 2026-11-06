import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getCartDetails: vi.fn(),
  mergeGuestCart: vi.fn(),
  getSettings: vi.fn(),
  listAddresses: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth-guard", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/services/cart.service", () => ({
  getCartDetails: mocks.getCartDetails,
  mergeGuestCart: mocks.mergeGuestCart,
}));
vi.mock("@/services/settings.service", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/services/users.service", () => ({ listAddresses: mocks.listAddresses }));
vi.mock("@/lib/performance-timing", () => ({
  withPerformanceTiming: (_name: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/lib/safepay/config", () => ({ isSafepaySandboxSessionConfigured: () => false }));
vi.mock("@/components/checkout/checkout-flow", () => ({ CheckoutFlow: () => null }));

import CheckoutPage from "@/app/(store)/checkout/page";

describe("checkout page authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`REDIRECT:${destination}`);
    });
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.getCartDetails.mockResolvedValue({
      id: "user-cart", items: [{ itemId: "line-1" }], itemCount: 1, subtotal: 1000, wrappedUnits: 0,
    });
    mocks.getSettings.mockResolvedValue({});
    mocks.listAddresses.mockResolvedValue([]);
    mocks.mergeGuestCart.mockResolvedValue(undefined);
  });

  it("redirects visitors to sign-in without consuming or changing their guest cart", async () => {
    await expect(CheckoutPage()).rejects.toThrow("REDIRECT:/login?callbackUrl=%2Fcheckout&reason=checkout");

    expect(mocks.mergeGuestCart).not.toHaveBeenCalled();
    expect(mocks.getCartDetails).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it("merges the preserved guest cart into the authenticated user's cart before checkout loads", async () => {
    const events: string[] = [];
    mocks.getSessionUser.mockResolvedValue({ id: "session-customer", name: "Buyer", email: "buyer@example.invalid" });
    mocks.mergeGuestCart.mockImplementation(async () => { events.push("merge"); });
    mocks.getCartDetails.mockImplementation(async () => {
      events.push("cart");
      return { id: "user-cart", items: [{ itemId: "line-1" }], itemCount: 1, subtotal: 1000, wrappedUnits: 0 };
    });
    mocks.getSettings.mockImplementation(async () => { events.push("settings"); return {}; });

    await CheckoutPage();

    expect(mocks.mergeGuestCart).toHaveBeenCalledWith("session-customer");
    expect(events.indexOf("merge")).toBeLessThan(events.indexOf("cart"));
  });
});
