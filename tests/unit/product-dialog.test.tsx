// @vitest-environment jsdom
// Product dialog (Phase 3 final, Stream A): the admin product form must not
// offer editable rating / review-count fields — those values are calculated
// from APPROVED reviews only (src/services/reviews.service.ts) and must
// never be typed in by an admin. Runs under vitest + jsdom; plain DOM
// assertions only — no jest-dom dependency in this repo.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src?: string | null; alt?: string }) =>
    React.createElement("img", { src: src ?? "", alt: alt ?? "" }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Radix Dialog measures with ResizeObserver, which jsdom does not
// provide — stub the observer (observe/unobserve/disconnect are no-ops).
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { EMPTY_PRODUCT, ProductDialog } from "@/components/admin/product-dialog";

afterEach(() => {
  cleanup();
});

describe("ProductDialog rating fields", () => {
  it("has no rating or review-count inputs in create mode", () => {
    const { container } = render(
      <ProductDialog
        open
        initial={EMPTY_PRODUCT}
        categories={[{ id: "category-1", name: "Category" }]}
        onClose={() => {}}
      />
    );

    // The dialog itself still renders (sanity: the form did not break).
    expect(screen.getByText("Add Product")).toBeTruthy();
    expect(screen.getByLabelText("Product name *")).toBeTruthy();

    // No editable rating / review-count fields, by id, label, or role.
    expect(container.querySelector("#pd-rating")).toBeNull();
    expect(container.querySelector("#pd-reviews")).toBeNull();
    expect(screen.queryByLabelText(/rating/i)).toBeNull();
    expect(screen.queryByLabelText(/review count/i)).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /rating/i })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /review count/i })).toBeNull();
  });

  it("has no rating or review-count inputs in edit mode", () => {
    const { container } = render(
      <ProductDialog
        open
        initial={{
          ...EMPTY_PRODUCT,
          id: "product-1",
          name: "Existing Product",
          categoryId: "category-1",
          price: 100,
          images: ["https://example.com/one.jpg"],
          stock: 3,
        }}
        categories={[{ id: "category-1", name: "Category" }]}
        sku="KH-EXI-PRO-42"
        onClose={() => {}}
      />
    );

    expect(screen.getByText("Edit Product")).toBeTruthy();
    expect(container.querySelector("#pd-rating")).toBeNull();
    expect(container.querySelector("#pd-reviews")).toBeNull();
    expect(screen.queryByLabelText(/rating/i)).toBeNull();
    expect(screen.queryByLabelText(/review count/i)).toBeNull();
  });
});
