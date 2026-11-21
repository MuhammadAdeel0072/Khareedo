// @vitest-environment jsdom
// Admin inventory manager tests (Phase 3, Chunk 12 follow-up A, M-18/M-8c):
// the drift warning renders with the count and per-item reasons when the
// drift audit finds held reservations without a live order, stays hidden
// when there is no drift, and held quantities are shown next to available
// stock so 0 available + held does not read as genuinely out-of-stock.
// Runs under vitest + jsdom; no real network. Plain DOM assertions only.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/inventory",
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { InventoryManager } from "@/components/admin/inventory-manager";
import type { InventoryDriftItem, InventoryRow } from "@/services/inventory.service";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    productId: "prod-1",
    variantId: null,
    variantLabel: null,
    productName: "Drift Watch",
    category: "Watches",
    quantity: 0,
    heldQuantity: 0,
    lowStockThreshold: 5,
    isLow: false,
    isOut: true,
    status: "PUBLISHED",
    ...overrides,
  };
}

function driftItem(overrides: Partial<InventoryDriftItem> = {}): InventoryDriftItem {
  return {
    inventoryId: "inv-1",
    productId: "prod-1",
    productName: "Drift Watch",
    reservationId: "res-1",
    orderId: "order-1",
    orderReference: "KH261120000001",
    heldQuantity: 2,
    orderItemQuantity: 2,
    orderStatus: "CANCELLED",
    reasons: ["ORDER_CLOSED"],
    ...overrides,
  };
}

describe("inventory drift warning (M-18)", () => {
  it("renders the count, order reference and reason when drift exists", () => {
    render(<InventoryManager initial={[row()]} drift={{ count: 1, items: [driftItem()] }} q="" filter="all" page={1} pages={1} total={1} />);
    expect(screen.getByText(/1 reservation holding stock without a live order/i)).toBeTruthy();
    expect(screen.getByText(/KH261120000001/)).toBeTruthy();
    expect(screen.getByText(/order closed but hold never released/i)).toBeTruthy();
  });

  it("renders nothing drift-related when there is no drift", () => {
    const { container } = render(<InventoryManager initial={[row()]} drift={{ count: 0, items: [] }} q="" filter="all" page={1} pages={1} total={1} />);
    expect(container.textContent).not.toMatch(/holding stock without a live order/i);
  });
});

describe("held quantities (M-8c)", () => {
  it("distinguishes held stock from genuinely out-of-stock", () => {
    render(
      <InventoryManager
        initial={[row({ quantity: 0, heldQuantity: 5, isOut: true })]}
        drift={{ count: 0, items: [] }}
        q="" filter="all" page={1} pages={1} total={1}
      />
    );
    expect(screen.getByText(/Out of stock — 5 held/i)).toBeTruthy();
    expect(screen.getByText(/5 held for pending payments/i)).toBeTruthy();
  });

  it("shows no held line when nothing is held", () => {
    const { container } = render(
      <InventoryManager initial={[row({ quantity: 4, heldQuantity: 0, isOut: false, isLow: true })]} drift={{ count: 0, items: [] }} q="" filter="all" page={1} pages={1} total={1} />
    );
    expect(container.textContent).not.toMatch(/held for pending payments/i);
  });

  it("shows the page count when the list is paginated", () => {
    const { container } = render(
      <InventoryManager initial={[row()]} drift={{ count: 0, items: [] }} q="" filter="all" page={2} pages={3} total={31} />
    );
    expect(container.textContent).toMatch(/showing page 2 of 3/i);
  });
});
