// @vitest-environment jsdom
// Admin order refunds panel tests (Phase 3, Chunk 2 partial, H-16): the
// panel shows the refundable balance and existing refunds, validates the
// requested amount client-side (never above the remaining balance), and
// posts refund requests to the existing admin refunds API. Runs under vitest
// + jsdom; no real network. Plain DOM assertions only — no jest-dom
// dependency in this repo.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  usePathname: () => "/admin/orders/order-1",
}));
vi.mock("sonner", () => ({ toast }));

import {
  AdminOrderRefundsPanel,
  type AdminRefundRow,
  type AdminRefundablePayment,
} from "@/components/admin/admin-order-refunds";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function payment(overrides: Partial<AdminRefundablePayment> = {}): AdminRefundablePayment {
  return {
    id: "payment-1",
    capturedAmountMinor: "230000",
    refundedAmountMinor: "0",
    paidVerifiedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    ...overrides,
  };
}

function refund(overrides: Partial<AdminRefundRow> = {}): AdminRefundRow {
  return {
    id: "refund-1",
    paymentId: "payment-1",
    amountMinor: "50000",
    currency: "PKR",
    type: "PARTIAL",
    status: "SUCCEEDED",
    providerReference: "prov-ref-1",
    providerState: "TRACKER_PARTIAL_REFUND",
    failureMessage: null,
    reviewReason: null,
    requestedAt: new Date("2026-01-02T10:00:00.000Z").toISOString(),
    confirmedAt: new Date("2026-01-02T10:05:00.000Z").toISOString(),
    ...overrides,
  };
}

function mockFetch(okPayload: Record<string, unknown>, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => okPayload,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AdminOrderRefundsPanel", () => {
  it("renders nothing when there is no paid payment and no refunds", () => {
    const { container } = render(
      <AdminOrderRefundsPanel payment={null} refunds={[]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the refundable balance and existing refunds", () => {
    render(<AdminOrderRefundsPanel payment={payment()} refunds={[refund()]} />);
    expect(screen.getByText("Refunds")).toBeTruthy();
    expect(screen.getByText("Refundable balance")).toBeTruthy();
    // Captured and refundable balance are both Rs 2,300 (nothing refunded yet).
    expect(screen.getAllByText("Rs 2,300")).toHaveLength(2);
    expect(screen.getByText(/Rs 500/)).toBeTruthy();
    expect(screen.getByText("SUCCEEDED")).toBeTruthy();
  });

  it("subtracts open refunds from the refundable balance", () => {
    render(
      <AdminOrderRefundsPanel
        payment={payment()}
        refunds={[refund({ id: "refund-2", status: "REQUESTED", amountMinor: "100000" })]}
      />
    );
    expect(screen.getByText("Rs 1,300")).toBeTruthy();
  });

  it("shows the reversal-window note for a recently captured payment", () => {
    render(
      <AdminOrderRefundsPanel
        payment={payment({ paidVerifiedAt: new Date().toISOString() })}
        refunds={[]}
      />
    );
    expect(screen.getByText(/less than 24 hours ago/)).toBeTruthy();
  });

  it("rejects an amount above the remaining balance without calling the API", () => {
    const fetchMock = mockFetch({ ok: true });
    render(<AdminOrderRefundsPanel payment={payment()} refunds={[]} />);
    fireEvent.change(screen.getByLabelText(/Refund amount/), {
      target: { value: "5000" },
    });
    fireEvent.click(screen.getByText("Request refund"));
    expect(screen.getByText(/exceeds the refundable balance/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a partial refund in minor units with an idempotency key", async () => {
    const fetchMock = mockFetch({
      ok: true,
      result: { kind: "created" },
      refund: { id: "refund-9" },
    });
    render(<AdminOrderRefundsPanel payment={payment()} refunds={[]} />);
    fireEvent.change(screen.getByLabelText(/Refund amount/), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByText("Request refund"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/payments/refunds");
    const body = JSON.parse(String(init.body));
    expect(body.paymentId).toBe("payment-1");
    expect(body.amountMinor).toBe(100000);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(16);
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("Refund requested")
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("posts without an amount for a full refund of the remaining balance", async () => {
    const fetchMock = mockFetch({ ok: true, result: { kind: "created" } });
    render(<AdminOrderRefundsPanel payment={payment()} refunds={[]} />);
    fireEvent.click(screen.getByText("Request refund"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).not.toHaveProperty("amountMinor");
    expect(body.paymentId).toBe("payment-1");
  });

  it("shows the parked-for-review outcome as a warning", async () => {
    const fetchMock = mockFetch({
      ok: true,
      result: { kind: "review_required", reason: "REFUND_WINDOW_REVERSAL_24H" },
    });
    render(
      <AdminOrderRefundsPanel
        payment={payment({ paidVerifiedAt: new Date().toISOString() })}
        refunds={[]}
      />
    );
    fireEvent.click(screen.getByText("Request refund"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining("parked for review")
    );
  });

  it("shows the server rejection reason on failure", async () => {
    const fetchMock = mockFetch(
      { ok: false, code: "REFUND_EXCEEDS_REMAINING" },
      false
    );
    render(<AdminOrderRefundsPanel payment={payment()} refunds={[]} />);
    fireEvent.change(screen.getByLabelText(/Refund amount/), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByText("Request refund"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("remaining refundable balance")
    );
  });
});
