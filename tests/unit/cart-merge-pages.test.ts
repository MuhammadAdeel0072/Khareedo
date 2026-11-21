// @vitest-environment jsdom
// Page wiring tests — cart merge trigger (Phase 3, Chunk 4-final, H-6/D7).
// The merge rules and the action itself are covered against the real DB by
// integration.cart-merge-trigger.test.ts; these tests cover the two page
// call sites: the cart page (merge before cart details load, summary
// forwarded to CartView) and the account page (the default post-login
// landing page — merge runs there, in parallel with the other reads).
// Runs under vitest + jsdom; no real network. Follows the
// checkout-auth-page.test.ts pattern (mock the services, assert call order).
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  mergeGuestCartAction: vi.fn(),
  getCartDetails: vi.fn(),
  getSettings: vi.fn(),
  getUserProfile: vi.fn(),
  getUserOrders: vi.fn(),
  getWishlistCount: vi.fn(),
  listAddresses: vi.fn(),
  redirect: vi.fn(),
}));
const capturedCartViewProps = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href: typeof href === "string" ? href : "#", ...props }, children),
}));
vi.mock("@/lib/auth-guard", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/actions/cart", () => ({ mergeGuestCartAction: mocks.mergeGuestCartAction }));
vi.mock("@/services/cart.service", () => ({ getCartDetails: mocks.getCartDetails }));
vi.mock("@/services/settings.service", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/services/users.service", () => ({
  getUserProfile: mocks.getUserProfile,
  listAddresses: mocks.listAddresses,
}));
vi.mock("@/services/orders.service", () => ({ getUserOrders: mocks.getUserOrders }));
vi.mock("@/services/wishlist.service", () => ({ getWishlistCount: mocks.getWishlistCount }));
vi.mock("@/components/cart/cart-view", () => ({
  CartView: (props: Record<string, unknown>) => {
    capturedCartViewProps.props = props;
    return null;
  },
  CartSkeleton: () => null,
}));

import CartPage from "@/app/(store)/cart/page";
import AccountPage from "@/app/(store)/account/page";

const EMPTY_SUMMARY = { merged: [], skipped: [], cookieCleared: true };
const SETTINGS = {
  whatsapp_number: "923001234567",
  store_name: "Khareedo",
  free_delivery_threshold: 5000,
  gift_wrap_enabled: false,
  gift_wrap_charge: 0,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  capturedCartViewProps.props = null;
});

describe("cart page merge trigger", () => {
  beforeEach(() => {
    mocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`REDIRECT:${destination}`);
    });
    mocks.getSettings.mockResolvedValue(SETTINGS);
    mocks.getCartDetails.mockResolvedValue({
      id: "user-cart",
      items: [],
      itemCount: 0,
      subtotal: 0,
      wrappedUnits: 0,
      removed: [],
    });
    mocks.mergeGuestCartAction.mockResolvedValue(EMPTY_SUMMARY);
  });

  it("merges before loading cart details and forwards the summary to CartView", async () => {
    const events: string[] = [];
    mocks.getSessionUser.mockResolvedValue({ id: "session-customer" });
    mocks.mergeGuestCartAction.mockImplementation(async () => {
      events.push("merge");
      return { merged: [{ productId: "p1", name: "Watch", quantity: 1 }], skipped: [], cookieCleared: true };
    });
    mocks.getCartDetails.mockImplementation(async () => {
      events.push("cart");
      return { id: "user-cart", items: [], itemCount: 0, subtotal: 0, wrappedUnits: 0, removed: [] };
    });

    render(await CartPage());

    expect(mocks.mergeGuestCartAction).toHaveBeenCalledTimes(1);
    expect(events.indexOf("merge")).toBeLessThan(events.indexOf("cart"));
    expect(capturedCartViewProps.props?.mergeSummary).toEqual({
      merged: [{ productId: "p1", name: "Watch", quantity: 1 }],
      skipped: [],
      cookieCleared: true,
    });
  });

  it("skips the merge for anonymous visitors and leaves the guest cart alone", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    render(await CartPage());

    expect(mocks.mergeGuestCartAction).not.toHaveBeenCalled();
    expect(mocks.getCartDetails).toHaveBeenCalledTimes(1);
    expect(capturedCartViewProps.props?.mergeSummary).toBeNull();
  });
});

describe("account page merge trigger (post-login landing)", () => {
  beforeEach(() => {
    mocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`REDIRECT:${destination}`);
    });
    mocks.getUserProfile.mockResolvedValue({ createdAt: new Date("2026-01-01") });
    mocks.getUserOrders.mockResolvedValue({ total: 0, items: [] });
    mocks.getWishlistCount.mockResolvedValue(0);
    mocks.listAddresses.mockResolvedValue([]);
    mocks.mergeGuestCartAction.mockResolvedValue(EMPTY_SUMMARY);
  });

  it("merges the guest cart when a signed-in customer lands on /account", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "session-customer" });

    await AccountPage();

    expect(mocks.mergeGuestCartAction).toHaveBeenCalledTimes(1);
  });

  it("redirects anonymous visitors to sign-in without merging", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    await expect(AccountPage()).rejects.toThrow("REDIRECT:/login?callbackUrl=/account");
    expect(mocks.mergeGuestCartAction).not.toHaveBeenCalled();
  });
});
