// @vitest-environment jsdom
// Payment-review queue tests (Phase 3, Chunk 2 partial, H-16): the queue
// renders cases with investigation/capture badges, gates the resolve actions
// on the verified provider outcome, and posts investigate/resolve actions to
// the existing admin APIs. Runs under vitest + jsdom; no real network. Plain
// DOM assertions only — no jest-dom dependency in this repo.
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
  usePathname: () => "/admin/payments/review",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href: typeof href === "string" ? href : "#", ...props }, children),
}));
vi.mock("sonner", () => ({ toast }));

import { PaymentReviewQueue } from "@/components/admin/payment-review-queue";
import type { PaymentReviewCase } from "@/services/payment-review.service";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function reviewCase(overrides: Partial<PaymentReviewCase> = {}): PaymentReviewCase {
  return {
    orderId: "order-1",
    reference: "KH2601010000001",
    orderStatus: "CANCELLED",
    paymentStatus: "PENDING",
    reviewReason: "PROVIDER_FINALITY_UNVERIFIED",
    closeReason: "CANCELLED",
    closedAt: new Date("2026-01-01T10:00:00.000Z").toISOString(),
    reservationExpiresAt: null,
    investigated: false,
    captureEvidence: false,
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

describe("PaymentReviewQueue", () => {
  it("shows an empty state when there are no cases", () => {
    render(<PaymentReviewQueue cases={[]} />);
    expect(screen.getByText("No payments are waiting for review.")).toBeTruthy();
  });

  it("renders a case with its reason and investigation badge", () => {
    render(<PaymentReviewQueue cases={[reviewCase()]} />);
    expect(screen.getByText("KH2601010000001")).toBeTruthy();
    expect(screen.getByText(/PROVIDER_FINALITY_UNVERIFIED/)).toBeTruthy();
    expect(screen.getByText("not investigated")).toBeTruthy();
  });

  it("disables release until investigated, and capture resolution until capture evidence exists", () => {
    render(
      <PaymentReviewQueue
        cases={[reviewCase(), reviewCase({ orderId: "order-2", reference: "KH2601010000002", investigated: true })]}
      />
    );
    const releaseButtons = screen.getAllByText("Resolve: not captured");
    expect((releaseButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((releaseButtons[1] as HTMLButtonElement).disabled).toBe(false);
    const captureButtons = screen.getAllByText("Resolve: captured");
    expect((captureButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((captureButtons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the capture warning and blocks release when capture evidence exists", () => {
    render(
      <PaymentReviewQueue
        cases={[reviewCase({ investigated: true, captureEvidence: true })]}
      />
    );
    expect(screen.getByText(/capture evidence/)).toBeTruthy();
    expect(screen.getByText(/A release is blocked/)).toBeTruthy();
    expect((screen.getByText("Resolve: not captured") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Resolve: captured") as HTMLButtonElement).disabled).toBe(false);
  });

  it("posts an investigation to the maintenance API and refreshes", async () => {
    const fetchMock = mockFetch({ ok: true, outcome: "review_required" });
    render(<PaymentReviewQueue cases={[reviewCase()]} />);
    fireEvent.click(screen.getByText("Investigate"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/payments/maintenance");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "investigate_closed_order_payment",
      orderId: "order-1",
    });
    expect(toast.success).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("confirms before resolving and posts the outcome to the review API", async () => {
    const fetchMock = mockFetch({ ok: true, outcome: "RELEASED" });
    render(
      <PaymentReviewQueue cases={[reviewCase({ investigated: true })]} />
    );
    fireEvent.click(screen.getByText("Resolve: not captured"));
    expect(screen.getByText("Release the holds?")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/payments/review");
    expect(JSON.parse(String(init.body))).toEqual({
      orderId: "order-1",
      outcome: "NOT_CAPTURED",
    });
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("Hold released")
    );
  });

  it("shows the server's hint when resolution is refused", async () => {
    const fetchMock = mockFetch(
      { ok: false, code: "INVESTIGATION_REQUIRED" },
      false
    );
    render(
      <PaymentReviewQueue cases={[reviewCase({ investigated: true })]} />
    );
    fireEvent.click(screen.getByText("Resolve: not captured"));
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Run Investigate first")
    );
  });
});
