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
    run: vi.fn(),
  };
});

vi.mock("@/lib/auth-guard", () => ({
  requireAdmin: mocks.requireAdmin,
  AuthError: mocks.TestAuthError,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/api", () => ({
  parseBody: async (
    request: Request,
    schema: {
      safeParse: (value: unknown) => {
        success: boolean;
        data?: unknown;
      };
    }
  ) => {
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return {
        error: Response.json({ ok: false }, { status: 400 }),
      };
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      return {
        error: Response.json({ ok: false }, { status: 400 }),
      };
    }

    return { data: parsed.data };
  },

  jsonOk: (data: unknown) =>
    Response.json({ ok: true, data }),
}));

vi.mock("@/services/payment-maintenance.service", () => ({
  MAINTENANCE_ACTIONS: [
    "expire_reservations",
    "process_webhook_inbox",
    "reconcile_due_payments",
    "verify_order_payment",
    "investigate_closed_order_payment",
  ],

  createPaymentMaintenanceRunner: () => ({
    run: mocks.run,
  }),
}));

import { POST } from "@/app/api/admin/payments/maintenance/route";

const validBody = {
  action: "investigate_closed_order_payment",
  orderId: "order_123",
};

function request(body: unknown) {
  return new Request(
    "http://localhost/api/admin/payments/maintenance",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}

describe("Closed-order investigation HTTP security", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.requireAdmin.mockResolvedValue({
      id: "admin_test",
      role: "ADMIN",
    });

    mocks.rateLimit.mockReturnValue({ ok: true });

    mocks.run.mockResolvedValue({
      action: "investigate_closed_order_payment",
      orderId: "order_123",
      outcome: "review_required",
    });
  });

  it.each([401, 403])(
    "rejects unauthorized request with HTTP %s",
    async status => {
      mocks.requireAdmin.mockRejectedValue(
        new mocks.TestAuthError(status)
      );

      const response = await POST(request(validBody));

      expect(response.status).toBe(status);
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );

  it("enforces administrator rate limiting", async () => {
    mocks.rateLimit.mockReturnValue({
      ok: false,
      retryAfterSec: 60,
    });

    const response = await POST(request(validBody));

    expect(response.status).toBe(429);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("requires an order ID", async () => {
    const response = await POST(request({
      action: "investigate_closed_order_payment",
    }));

    expect(response.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects a browser-supplied tracker token", async () => {
    const response = await POST(request({
      ...validBody,
      trackerToken: "forged_tracker",
    }));

    expect(response.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects invalid order identifiers", async () => {
    const response = await POST(request({
      ...validBody,
      orderId: "invalid order!",
    }));

    expect(response.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("permits an authorized investigation", async () => {
    const response = await POST(request(validBody));

    expect(response.status).toBe(200);

    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(
      "investigate_closed_order_payment",
      25,
      { orderId: "order_123" }
    );

    expect(response.headers.get("Cache-Control")).toBe(
      "no-store"
    );
  });
});
