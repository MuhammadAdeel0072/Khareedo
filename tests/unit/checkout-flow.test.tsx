// @vitest-environment jsdom
// Checkout-flow UI tests (Phase 3, chunk 1): stepper labels (H-17), quote
// failure state (M-36), failed online-payment lock reset (H-18) and the
// step-1 busy state (M-35). Runs under vitest + jsdom; no real network.
// Plain DOM assertions only — no jest-dom dependency in this repo.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mockPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href: typeof href === "string" ? href : "#", ...props }, children),
}));
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src?: string | null; alt?: string }) =>
    React.createElement("img", { src: src ?? "", alt: alt ?? "" }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { CheckoutFlow, type CheckoutAddress, type CheckoutConfig } from "@/components/checkout/checkout-flow";
import type { CartDetails, GuestCartMergeSummary } from "@/types/cart";

const baseCart: CartDetails = {
  id: "cart-1",
  items: [{
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
  }],
  itemCount: 1,
  subtotal: 1000,
  wrappedUnits: 0,
  removed: [],
};

const baseConfig: CheckoutConfig = {
  codEnabled: true,
  sandboxPaymentEnabled: false,
  giftWrapEnabled: false,
  giftWrapCharge: 0,
  giftWrapDescription: "",
  freeDeliveryThreshold: 0,
  deliveryFeeStandard: 200,
  deliveryFeeExpress: 500,
  whatsappNumber: "03001234567",
  storeName: "Khareedo",
};

const savedAddress: CheckoutAddress = {
  id: "addr-1",
  label: "Home",
  fullName: "Test Buyer",
  phone: "03001234567",
  line1: "Test Street 1",
  line2: "",
  city: "Lahore",
  province: "Punjab",
  postalCode: "",
  isDefault: true,
};

const user = { id: "user-1", name: "Test Buyer", email: "test@buyer.pk" };

const quoteBody = {
  ok: true,
  quote: {
    subtotal: 1000,
    discountTotal: 0,
    deliveryFee: 200,
    giftWrapCharge: 0,
    wrappedUnits: 0,
    taxTotal: 0,
    total: 1200,
    itemCount: 1,
  },
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

function renderFlow(overrides: {
  cart?: CartDetails;
  mergeSummary?: GuestCartMergeSummary;
  config?: CheckoutConfig;
  savedAddresses?: CheckoutAddress[];
  user?: typeof user | null;
} = {}) {
  return render(
    <CheckoutFlow
      cart={overrides.cart ?? baseCart}
      mergeSummary={overrides.mergeSummary}
      config={overrides.config ?? baseConfig}
      user={overrides.user === undefined ? user : overrides.user}
      savedAddresses={overrides.savedAddresses ?? [savedAddress]}
      initialName="Test Buyer"
      initialEmail="test@buyer.pk"
    />
  );
}

// The mobile step text wraps the label in a <span>, so the exact string
// never matches a single text node — match on the element's full textContent.
function stepText(step: number, label: string) {
  return screen.getByText((_content, element) => element?.textContent === `Step ${step} of 4: ${label}`);
}

function isDisabled(element: HTMLElement) {
  return (element as HTMLButtonElement).disabled;
}

function goToReview() {
  fireEvent.click(screen.getByRole("button", { name: "Continue to Delivery" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));
  fireEvent.click(screen.getByRole("button", { name: /Review Order/ }));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    url === "/api/checkout/quote" ? jsonResponse(quoteBody) : jsonResponse({ ok: true })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("checkout stepper (H-17)", () => {
  it("labels the four steps Address, Delivery, Payment, Review", async () => {
    renderFlow();
    await waitFor(() => expect(stepText(1, "Address")).not.toBeNull());
    // The four labels live in the stepper itself (the mobile "Step X of 4"
    // line repeats the current label in a nested span).
    const stepper = screen.getByRole("list", { name: "Checkout progress" });
    expect(within(stepper).getByText("Address")).not.toBeNull();
    expect(within(stepper).getByText("Delivery")).not.toBeNull();
    expect(within(stepper).getByText("Payment")).not.toBeNull();
    expect(within(stepper).getByText("Review")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue to Delivery" }));
    await waitFor(() => expect(stepText(2, "Delivery")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));
    await waitFor(() => expect(stepText(3, "Payment")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Review Order/ }));
    await waitFor(() => expect(stepText(4, "Review")).not.toBeNull());
    // Confirm shows the quoted total, never Rs 0.
    expect(screen.getByRole("button", { name: /Confirm Order — Rs 1,200/ })).not.toBeNull();
  });
});

describe("quote failure state (M-36)", () => {
  it("disables Confirm and shows an error instead of Confirm Order — Rs 0", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/checkout/quote"
        ? jsonResponse({ ok: false, error: "Quote unavailable" }, 500)
        : jsonResponse({ ok: true })
    );
    renderFlow();
    goToReview();
    const confirm = await waitFor(() => screen.getByRole("button", { name: "Confirm Order" }));
    await waitFor(() => expect(isDisabled(confirm)).toBe(true));
    expect(confirm.textContent).not.toContain("Rs 0");
    // The reason is shown in the Review step and in the summary total box.
    expect(screen.getAllByText("Quote unavailable")).toHaveLength(2);
  });
});

describe("failed online-payment attempt (H-18)", () => {
  it("re-enables checkout after the session endpoint fails", async () => {
    const onlineConfig = { ...baseConfig, sandboxPaymentEnabled: true };
    let releaseSession!: (response: Response) => void;
    const sessionPromise = new Promise<Response>((resolve) => {
      releaseSession = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/checkout/quote") return jsonResponse(quoteBody);
      if (url === "/api/checkout/safepay/session") return sessionPromise;
      return jsonResponse({ ok: true });
    });
    renderFlow({ config: onlineConfig });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Delivery" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));
    fireEvent.click(screen.getByText(/Online Payment \(Sandbox\)/));
    fireEvent.click(screen.getByRole("button", { name: /Review Order/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Confirm Order — Rs 1,200/ })).not.toBeNull()
    );
    const increase = screen.getByRole("button", { name: "Increase quantity of Test Watch" });
    expect(isDisabled(increase)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Confirm Order — Rs 1,200/ }));
    // While the attempt is in flight the checkout is locked…
    await waitFor(() => expect(isDisabled(increase)).toBe(true));
    // …and the lock releases when the attempt fails.
    await act(async () => {
      releaseSession(jsonResponse({ ok: false, error: "Could not start the online payment." }, 500));
    });
    await waitFor(() => expect(isDisabled(increase)).toBe(false));
    // Confirm is usable again — the failed attempt did not soft-lock checkout.
    expect(isDisabled(screen.getByRole("button", { name: /Confirm Order — Rs 1,200/ }))).toBe(false);
  });
});

describe("step-1 address save (M-35)", () => {
  it("disables Continue and shows Saving… while the address save is in flight", async () => {
    let releaseSave!: (response: Response) => void;
    const savePromise = new Promise<Response>((resolve) => {
      releaseSave = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/checkout/quote") return jsonResponse(quoteBody);
      if (url === "/api/account/addresses") return savePromise;
      return jsonResponse({ ok: true });
    });
    // No saved addresses: the new-address form is shown.
    renderFlow({ savedAddresses: [] });
    fireEvent.change(screen.getByPlaceholderText("0300 1234567"), { target: { value: "03001234567" } });
    fireEvent.change(screen.getByPlaceholderText("House no, street, area"), { target: { value: "Test Street 1" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. Lahore"), { target: { value: "Lahore" } });

    const continueButton = screen.getByRole("button", { name: "Continue to Delivery" });
    fireEvent.click(continueButton);
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: /Saving…/ }))).toBe(true));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/account/addresses")).toHaveLength(1);

    await act(async () => {
      releaseSave(
        jsonResponse({
          ok: true,
          address: { ...savedAddress, id: "addr-new" },
        })
      );
    });
    await waitFor(() => expect(stepText(2, "Delivery")).not.toBeNull());
  });
});

describe("guest-cart merge notice (H-7)", () => {
  const mergeSummary: GuestCartMergeSummary = {
    merged: [{ productId: "prod-1", name: "Test Watch", quantity: 1 }],
    skipped: [
      { productId: "prod-2", name: "Sold Out Watch", reason: "out_of_stock" },
      { productId: "prod-3", name: "Old Watch", reason: "unavailable" },
    ],
    cookieCleared: false,
  };

  it("shows what was merged and what was skipped, and dismisses", async () => {
    renderFlow({ mergeSummary });
    await waitFor(() => expect(stepText(1, "Address")).not.toBeNull());
    expect(screen.getByText(/Your guest cart was merged — 1 item added to your cart\./)).not.toBeNull();
    expect(screen.getByText(/Couldn't add 2 items:/)).not.toBeNull();
    expect(screen.getByText(/Sold Out Watch \(out of stock\)/)).not.toBeNull();
    expect(screen.getByText(/Old Watch \(no longer available\)/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss merge notice" }));
    expect(screen.queryByText(/Your guest cart was merged/)).toBeNull();
  });

  it("shows nothing when there is nothing to merge", async () => {
    renderFlow({ mergeSummary: { merged: [], skipped: [], cookieCleared: true } });
    await waitFor(() => expect(stepText(1, "Address")).not.toBeNull());
    expect(screen.queryByText(/Your guest cart was merged/)).toBeNull();
    expect(screen.queryByText(/Couldn't add/)).toBeNull();
  });
});

describe("delivery option fees use the pricing engine (chunk 12)", () => {
  const feeConfig = {
    ...baseConfig,
    freeDeliveryThreshold: 5000,
    deliveryFeeStandard: 200,
    deliveryFeeExpress: 500,
  };

  function standardOptionFee() {
    const title = screen.getByText("Standard Delivery");
    const label = title.closest("label");
    if (!label) throw new Error("Standard Delivery option label not found");
    return within(label);
  }

  it("shows the standard fee below the free-delivery threshold", async () => {
    renderFlow({ config: feeConfig });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Delivery" }));
    await waitFor(() => expect(stepText(2, "Delivery")).not.toBeNull());
    // Quote subtotal is 1,000 < 5,000 threshold: standard fee applies.
    expect(standardOptionFee().getByText("Rs 200")).not.toBeNull();
    expect(standardOptionFee().queryByText("Free")).toBeNull();
    // Express always charges its own fee.
    const expressTitle = screen.getByText("Express Delivery");
    expect(within(expressTitle.closest("label")!).getByText("Rs 500")).not.toBeNull();
  });

  it("shows Free for standard delivery at or above the threshold", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/checkout/quote"
        ? jsonResponse({ ok: true, quote: { ...quoteBody.quote, subtotal: 6000, total: 6200 } })
        : jsonResponse({ ok: true })
    );
    renderFlow({ config: feeConfig });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Delivery" }));
    await waitFor(() => expect(stepText(2, "Delivery")).not.toBeNull());
    // Quote subtotal 6,000 >= 5,000 threshold: standard delivery is free.
    // waitFor covers the quote fetch resolving after step 2 renders.
    await waitFor(() => expect(standardOptionFee().getByText("Free")).not.toBeNull());
  });
});

describe("delivery options are real radio values (chunk 12 follow-up B)", () => {
  // The delivery RadioGroupItem used to carry value={title} ("Standard
  // Delivery") while the group held "STANDARD": no item ever matched, so
  // nothing showed checked, arrow-key navigation did nothing, and clicking
  // fired onValueChange with the title — leaving deliveryMethod as
  // "Standard Delivery", which placeOrderSchema rejects.
  it("checks the selected method, switches on click, and arrow-key navigates", async () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Delivery" }));
    await waitFor(() => expect(stepText(2, "Delivery")).not.toBeNull());

    const standard = screen.getByRole("radio", { name: /Standard Delivery/ });
    const express = screen.getByRole("radio", { name: /Express Delivery/ });
    expect(standard.getAttribute("aria-checked")).toBe("true");
    expect(express.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(express);
    expect(express.getAttribute("aria-checked")).toBe("true");
    expect(standard.getAttribute("aria-checked")).toBe("false");

    // Arrow-key navigation moves selection back to standard. Radix defers
    // the focus move to a setTimeout, so the assertion waits for it.
    fireEvent.keyDown(express, { key: "ArrowUp" });
    await waitFor(() => expect(standard.getAttribute("aria-checked")).toBe("true"));
    expect(express.getAttribute("aria-checked")).toBe("false");
  });
});
