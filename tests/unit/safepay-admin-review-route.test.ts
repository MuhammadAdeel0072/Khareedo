import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TestAuthError extends Error {
    constructor(public readonly status: number) {
      super("Access denied");
    }
  }

  return {
    TestAuthError,
    requireAdmin: vi.fn(),
    rateLimit: vi.fn(),
    findMany: vi.fn(),
  };
});

vi.mock("@/lib/auth-guard", () => ({
  requireAdmin: mocks.requireAdmin,
  AuthError: mocks.TestAuthError,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/db", () => ({
  db: {
    order: {
      findMany: mocks.findMany,
    },
  },
}));

import { GET } from "@/app/api/admin/payments/review/route";

describe("Admin Safepay financial-review queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.requireAdmin.mockResolvedValue({
      id: "admin_test",
      role: "ADMIN",
    });

    mocks.rateLimit.mockReturnValue({
      ok: true,
    });

    mocks.findMany.mockResolvedValue([]);
  });

  it("rejects unauthenticated requests", async () => {
    mocks.requireAdmin.mockRejectedValue(
      new mocks.TestAuthError(401)
    );

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects non-admin requests", async () => {
    mocks.requireAdmin.mockRejectedValue(
      new mocks.TestAuthError(403)
    );

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("enforces rate limiting", async () => {
    mocks.rateLimit.mockReturnValue({
      ok: false,
      retryAfterSec: 60,
    });

    const response = await GET();

    expect(response.status).toBe(429);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns only sanitized review cases to administrators", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "order_123",
        reference: "KH_TEST_123",
        status: "CANCELLED",
        paymentStatus: "PENDING",
        paymentReviewReason: "PROVIDER_FINALITY_UNVERIFIED",
        checkoutCloseReason: "EXPIRED",
        checkoutClosedAt: new Date("2026-11-12T12:00:00Z"),
        reservationExpiresAt: new Date("2026-11-12T11:59:00Z"),

        // Deliberately injected sensitive fields.
        trackerToken: "SECRET_TRACKER_DO_NOT_EXPOSE",
        merchantSecret: "SECRET_MERCHANT_DO_NOT_EXPOSE",
        customerEmail: "private@example.test",
      },
    ]);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    expect(data.ok).toBe(true);
    expect(data.cases).toHaveLength(1);

    expect(data.cases[0]).toEqual({
      orderId: "order_123",
      reference: "KH_TEST_123",
      orderStatus: "CANCELLED",
      paymentStatus: "PENDING",
      reviewReason: "PROVIDER_FINALITY_UNVERIFIED",
      closeReason: "EXPIRED",
      closedAt: "2026-11-12T12:00:00.000Z",
      reservationExpiresAt: "2026-11-12T11:59:00.000Z",
    });

    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain("SECRET_TRACKER");
    expect(serialized).not.toContain("SECRET_MERCHANT");
    expect(serialized).not.toContain("private@example.test");

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          paymentFlowVersion: 1,
          paymentReviewStatus: "REQUIRED",
        },
        take: 25,
      })
    );
  });
});
