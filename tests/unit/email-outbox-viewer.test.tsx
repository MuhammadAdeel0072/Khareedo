// @vitest-environment jsdom
// Admin email-outbox viewer (Phase 3 Chunk 7, H-15; Stream G verification).
// The list + detail pages render the real server components with the list /
// detail service calls mocked — the only thing mocked away is the data
// source, not the code under test. Asserts the order events show with their
// human labels and order reference (Stream G: the list page used to show
// the label but not the order reference), and unit-tests the two viewer
// helpers (emailOutboxTypeLabel, emailOutboxOrderReference), which had no
// coverage before Stream G.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listEmailOutboxEntries: vi.fn(),
  getEmailOutboxEntry: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));
// The service module under test is imported for real (helpers below); only
// its database is stubbed, and the two data functions are overridden.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/services/email.service", () => ({
  isEmailDeliveryConfigured: () => true,
  classifyEmailSendError: () => ({ kind: "transient", permanent: false, authFailure: false, reason: "Transient email delivery failure — will retry with backoff." }),
  resetEmailTransporter: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendOrderConfirmedEmail: vi.fn(),
  sendOrderStatusEmail: vi.fn(),
  sendOrderCancelledEmail: vi.fn(),
  sendOrderPaymentSucceededEmail: vi.fn(),
  sendOrderPaymentFailedEmail: vi.fn(),
  sendOrderRefundSucceededEmail: vi.fn(),
}));
vi.mock("@/lib/error-monitoring", () => ({
  captureError: vi.fn(),
  capturePaymentAlert: vi.fn(),
}));
vi.mock("@/services/email-outbox.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/email-outbox.service")>();
  return {
    ...actual,
    listEmailOutboxEntries: mocks.listEmailOutboxEntries,
    getEmailOutboxEntry: mocks.getEmailOutboxEntry,
  };
});

import {
  emailOutboxOrderReference,
  emailOutboxTypeLabel,
} from "@/services/email-outbox.service";
import AdminEmailOutboxPage from "@/app/admin/(panel)/email-outbox/page";
import AdminEmailOutboxDetailPage from "@/app/admin/(panel)/email-outbox/[id]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function orderPayload(reference: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    orderId: "ord-1",
    reference,
    customerName: "Test Buyer",
    total: 2000,
    paymentMethod: "COD",
    ...extra,
  });
}

function outboxEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    type: "ORDER_CONFIRMED",
    email: "buyer@example.invalid",
    payload: orderPayload("KH261120000001"),
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: new Date("2026-11-20T10:00:00.000Z"),
    lastError: null,
    createdAt: new Date("2026-11-20T09:55:00.000Z"),
    ...overrides,
  };
}

describe("emailOutboxTypeLabel", () => {
  it.each([
    ["PASSWORD_RESET", "Password reset"],
    ["EMAIL_VERIFICATION", "Email verification"],
    ["ORDER_CONFIRMED", "Order confirmation"],
    ["ORDER_STATUS", "Order status update"],
    ["ORDER_CANCELLED", "Order cancellation"],
    ["ORDER_PAYMENT_SUCCEEDED", "Payment success"],
    ["ORDER_PAYMENT_FAILED", "Payment failure"],
    ["ORDER_REFUND_SUCCEEDED", "Refund success"],
  ])("labels %s as %s", (type, label) => {
    expect(emailOutboxTypeLabel(type)).toBe(label);
  });

  it("passes an unknown type through unchanged so a future type is never invisible", () => {
    expect(emailOutboxTypeLabel("FUTURE_TYPE")).toBe("FUTURE_TYPE");
  });
});

describe("emailOutboxOrderReference", () => {
  it("returns the reference from a valid order payload", () => {
    expect(emailOutboxOrderReference(orderPayload("KH261120000001"))).toBe("KH261120000001");
  });

  it("returns null for a null payload (auth rows)", () => {
    expect(emailOutboxOrderReference(null)).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(emailOutboxOrderReference("{not json")).toBeNull();
  });

  it("returns null when the payload has no reference", () => {
    expect(emailOutboxOrderReference(JSON.stringify({ callbackUrl: "/checkout" }))).toBeNull();
    expect(emailOutboxOrderReference(JSON.stringify({ reference: 42 }))).toBeNull();
  });
});

describe("admin outbox list page", () => {
  beforeEach(() => {
    mocks.listEmailOutboxEntries.mockResolvedValue({
      entries: [
        outboxEntry(),
        outboxEntry({
          id: "row-2",
          type: "ORDER_STATUS",
          email: "buyer2@example.invalid",
          payload: orderPayload("KH261120000002", { status: "SHIPPED", carrier: "TCS", trackingNumber: "TRK-123" }),
          status: "FAILED",
          attempts: 5,
          lastError: "Error: SMTP connection refused",
        }),
      ],
      total: 2,
      page: 1,
      perPage: 25,
    });
  });

  it("shows order events with their labels, recipients and order references", async () => {
    const element = await AdminEmailOutboxPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(screen.getByText("Order confirmation")).toBeTruthy();
    expect(screen.getByText("Order status update")).toBeTruthy();
    expect(screen.getByText("buyer@example.invalid")).toBeTruthy();
    expect(screen.getByText("buyer2@example.invalid")).toBeTruthy();
    // The order reference column (Stream G fix): the list used to show
    // only the label — the reference was detail-only.
    expect(screen.getByText("KH261120000001")).toBeTruthy();
    expect(screen.getByText("KH261120000002")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("Error: SMTP connection refused")).toBeTruthy();
    expect(mocks.listEmailOutboxEntries).toHaveBeenCalledWith({
      status: undefined,
      page: 1,
      perPage: 25,
    });
  });

  it("passes the status filter through from the query string", async () => {
    const element = await AdminEmailOutboxPage({
      searchParams: Promise.resolve({ status: "FAILED" }),
    });
    render(element);

    expect(mocks.listEmailOutboxEntries).toHaveBeenCalledWith({
      status: "FAILED",
      page: 1,
      perPage: 25,
    });
  });

  it("shows a dash for the order column when the row has no order payload", async () => {
    mocks.listEmailOutboxEntries.mockResolvedValue({
      entries: [
        outboxEntry({ id: "row-3", type: "PASSWORD_RESET", payload: null }),
      ],
      total: 1,
      page: 1,
      perPage: 25,
    });
    const element = await AdminEmailOutboxPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(screen.getByText("Password reset")).toBeTruthy();
    // The dash appears twice: the order column (no payload) and the
    // last-error column (null error).
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("shows the empty state when nothing matches", async () => {
    mocks.listEmailOutboxEntries.mockResolvedValue({
      entries: [],
      total: 0,
      page: 1,
      perPage: 25,
    });
    const element = await AdminEmailOutboxPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(screen.getByText(/No outbox entries match these filters/)).toBeTruthy();
  });
});

describe("admin outbox detail page", () => {
  it("shows a FAILED refund row with its label, order reference and retry action", async () => {
    mocks.getEmailOutboxEntry.mockResolvedValue(
      outboxEntry({
        id: "row-9",
        type: "ORDER_REFUND_SUCCEEDED",
        payload: orderPayload("KH261120000009", { refundAmountMinor: "50000" }),
        status: "FAILED",
        attempts: 3,
        lastError: "Error: SMTP connection refused",
      })
    );
    const element = await AdminEmailOutboxDetailPage({
      params: Promise.resolve({ id: "row-9" }),
    });
    render(element);

    expect(screen.getByText("Refund success")).toBeTruthy();
    expect(screen.getByText("KH261120000009")).toBeTruthy();
    expect(screen.getByText("3 / 5")).toBeTruthy();
    expect(screen.getByText("Error: SMTP connection refused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry delivery" })).toBeTruthy();
    expect(mocks.getEmailOutboxEntry).toHaveBeenCalledWith("row-9");
  });

  it("shows no retry action for a PENDING row", async () => {
    mocks.getEmailOutboxEntry.mockResolvedValue(outboxEntry());
    const element = await AdminEmailOutboxDetailPage({
      params: Promise.resolve({ id: "row-1" }),
    });
    render(element);

    expect(screen.getByText("Order confirmation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry delivery" })).toBeNull();
  });

  it("renders not-found for a missing row", async () => {
    mocks.getEmailOutboxEntry.mockResolvedValue(null);
    await expect(
      AdminEmailOutboxDetailPage({ params: Promise.resolve({ id: "missing" }) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
