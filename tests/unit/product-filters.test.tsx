// @vitest-environment jsdom
// Product-filters "Clear all filters" visibility (Phase 3, chunk 12):
// hasFilters used to compare the min/max params against null, but they
// always default to the full range, so it was always true and the button
// never hid. Runs under vitest + jsdom; no real network.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
}));

// Radix Slider measures its track with ResizeObserver, which jsdom does
// not provide — stub the observer (observe/unobserve/disconnect are no-ops).
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { ProductFilters } from "@/components/products/product-filters";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderFilters(query = "") {
  search.value = query;
  return render(
    <ProductFilters
      categories={[{ name: "Shoes", slug: "shoes", productCount: 3 }]}
      brands={["Acme"]}
      maxPrice={50000}
      totalResults={5}
    />
  );
}

describe("product filters — Clear all filters (hasFilters)", () => {
  it("hides the button when no filter is active", () => {
    renderFilters();
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
  });

  it("shows the button for a category, brand or in-stock filter", () => {
    renderFilters("category=shoes");
    expect(screen.getByRole("button", { name: "Clear all filters" })).not.toBeNull();
    cleanup();

    renderFilters("brand=Acme");
    expect(screen.getByRole("button", { name: "Clear all filters" })).not.toBeNull();
    cleanup();

    renderFilters("instock=1");
    expect(screen.getByRole("button", { name: "Clear all filters" })).not.toBeNull();
  });

  it("shows the button when the price range actually narrows the listing", () => {
    renderFilters("min=100");
    expect(screen.getByRole("button", { name: "Clear all filters" })).not.toBeNull();
    cleanup();

    renderFilters("max=1000");
    expect(screen.getByRole("button", { name: "Clear all filters" })).not.toBeNull();
  });

  it("hides the button when min/max equal the full range", () => {
    renderFilters("min=0");
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
    cleanup();

    renderFilters("max=50000");
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
    cleanup();

    renderFilters("min=0&max=50000");
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
  });
});
