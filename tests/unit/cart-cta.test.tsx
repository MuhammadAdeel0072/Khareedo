// @vitest-environment jsdom
// Cart CTA gating tests (Phase 3, Chunk 4, M-14): the add-to-cart button is
// disabled with a reason when the product is out of stock, the PDP quantity
// stepper cannot exceed available stock (and caps at the API ceiling of 20),
// and the cart checkout CTAs are disabled when the cart holds no
// purchasable unit. Also covers the M-13 removed-lines notice in the cart
// view. Runs under vitest + jsdom; no real network. Plain DOM assertions
// only — no jest-dom dependency in this repo.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/cart",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href: typeof href === "string" ? href : "#", ...props }, children),
}));
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src?: string | null; alt?: string }) =>
    React.createElement("img", { src: src ?? "", alt: alt ?? "" }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AddToCartButton } from "@/components/cart/add-to-cart-button";
import { CartView } from "@/components/cart/cart-view";
import { PdpActions } from "@/components/products/pdp-actions";
import type { CartDetails, CartItemDetail } from "@/types/cart";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function cartItem(overrides: Partial<CartItemDetail> = {}): CartItemDetail {
  return {
    itemId: "item-1",
    productId: "prod-1",
    variantId: null,
    variantLabel: null,
    name: "Test Watch",
    slug: "test-watch",
    price: 1000,
    comparePrice: null,
    image: null,
    quantity: 1,
    stock: 5,
    lowStock: false,
    outOfStock: false,
    lineTotal: 1000,
    giftWrap: false,
    ...overrides,
  };
}

function cart(overrides: Partial<CartDetails> = {}): CartDetails {
  return {
    id: "cart-1",
    items: [cartItem()],
    itemCount: 1,
    subtotal: 1000,
    wrappedUnits: 0,
    removed: [],
    ...overrides,
  };
}

function renderCartView(initialCart: CartDetails) {
  return render(
    <CartView
      initialCart={initialCart}
      whatsappNumber="03001234567"
      storeName="Khareedo"
      freeDeliveryThreshold={5000}
      giftWrapEnabled={false}
      giftWrapCharge={0}
    />
  );
}

describe("add-to-cart button (M-14)", () => {
  it("is disabled with the reason shown when the product is out of stock", () => {
    render(<AddToCartButton productId="prod-1" stock={0} />);
    const button = screen.getByRole("button", { name: "Out of Stock" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("is enabled and names the available stock when the product is in stock", () => {
    render(<AddToCartButton productId="prod-1" stock={5} />);
    const button = screen.getByRole("button", { name: /Add to Cart/ });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-label")).toContain("5 in stock");
  });
});

describe("PDP purchase panel (M-14)", () => {
  it("shows the out-of-stock reason and disabled actions when stock is 0", () => {
    render(<PdpActions productId="prod-1" stock={0} price={1000} />);
    expect(screen.getByText("This item is currently out of stock — check back soon.")).not.toBeNull();
    for (const button of screen.getAllByRole("button", { name: "Out of Stock" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  // The in-flow stepper is the one that displays the "Quantity: N" label;
  // the sticky bar renders a second stepper (its own, sharing the same
  // qty state) whenever there is no IntersectionObserver — including
  // jsdom — so the query must scope to the labelled group instead of
  // assuming a single "Increase quantity" button.
  function inflowIncreaseButton() {
    const groups = screen.getAllByRole("group", { name: "Quantity" });
    const inflow = groups.find((g) => within(g).queryByLabelText(/^Quantity: \d+$/));
    if (!inflow) throw new Error("In-flow quantity stepper not found");
    return within(inflow).getByRole("button", { name: "Increase quantity" });
  }

  it("caps the quantity stepper at the API ceiling of 20, never above stock", () => {
    render(<PdpActions productId="prod-1" stock={25} price={1000} />);
    const increase = inflowIncreaseButton();
    for (let i = 0; i < 30; i += 1) fireEvent.click(increase);
    expect(screen.getByLabelText("Quantity: 20")).not.toBeNull();
    expect((increase as HTMLButtonElement).disabled).toBe(true);
  });

  it("caps the quantity stepper at available stock below 20", () => {
    render(<PdpActions productId="prod-1" stock={3} price={1000} />);
    const increase = inflowIncreaseButton();
    for (let i = 0; i < 10; i += 1) fireEvent.click(increase);
    expect(screen.getByLabelText("Quantity: 3")).not.toBeNull();
    expect((increase as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("cart checkout CTA gating (M-14)", () => {
  it("disables both checkout CTAs with a reason when no line is purchasable", () => {
    const deadCart = cart({
      items: [cartItem({ quantity: 0, stock: 0, outOfStock: true, lineTotal: 0 })],
      itemCount: 0,
      subtotal: 0,
    });
    renderCartView(deadCart);
    const proceed = screen.getByRole("button", { name: "Proceed to Checkout" });
    expect((proceed as HTMLButtonElement).disabled).toBe(true);
    const mobile = screen.getByRole("button", { name: "Checkout" });
    expect((mobile as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No items in your cart are available to purchase right now.")).not.toBeNull();
    expect(screen.getByText("No items available to purchase right now.")).not.toBeNull();
  });

  it("keeps the checkout CTAs enabled when the cart holds a purchasable line", () => {
    renderCartView(cart());
    // Enabled CTAs render as links (Button asChild); disabled ones render
    // as real disabled buttons — see the test above.
    expect(screen.getByRole("link", { name: "Proceed to Checkout" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Checkout" })).not.toBeNull();
    expect(screen.queryByText("No items in your cart are available to purchase right now.")).toBeNull();
  });
});

describe("removed-lines notice (M-13)", () => {
  it("names the removed items and dismisses", () => {
    renderCartView(
      cart({
        removed: [
          { productId: "prod-2", name: "Gone Watch" },
          { productId: "prod-3", name: "Old Watch" },
        ],
      })
    );
    expect(screen.getByText(/2 items removed from your cart/)).not.toBeNull();
    expect(screen.getByText(/Gone Watch, Old Watch/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss removed items notice" }));
    expect(screen.queryByText(/2 items removed from your cart/)).toBeNull();
  });
});
