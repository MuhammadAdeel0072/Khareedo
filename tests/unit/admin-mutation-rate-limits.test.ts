// Rate limits on the admin mutation routes and account write routes
// added by the performance/reliability stream (60/min per admin or per
// user, 429 + Retry-After once exhausted).
//
// Representative coverage — one route per shared bucket slug family —
// rather than all 24 call sites: the limiter call is identical in each
// route, so one passing route per slug family proves the wiring. The
// in-memory limiter is module state, so each test uses a distinct admin
// or user id and the tests run in one file, in order.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireAdmin, mockRequireUser, mockAdminUpdateInventory, mockAdminUpdateOrderStatus, mockUpdateProfile } =
  vi.hoisted(() => ({
    mockRequireAdmin: vi.fn(),
    mockRequireUser: vi.fn(),
    mockAdminUpdateInventory: vi.fn(),
    mockAdminUpdateOrderStatus: vi.fn(),
    mockUpdateProfile: vi.fn(),
  }));

vi.mock("@/lib/auth-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-guard")>();
  return {
    ...actual,
    requireAdminMfaVerified: mockRequireAdmin,
    requireUser: mockRequireUser,
  };
});

vi.mock("@/services/inventory.service", () => ({
  adminUpdateInventory: mockAdminUpdateInventory,
}));

vi.mock("@/services/orders.service", () => ({
  adminUpdateOrderStatus: mockAdminUpdateOrderStatus,
}));

vi.mock("@/services/users.service", () => ({
  updateProfile: mockUpdateProfile,
}));

vi.mock("@/services/admin-audit.service", () => ({
  ADMIN_AUDIT_ACTIONS: { INVENTORY_UPDATED: "INVENTORY_UPDATED" },
  adminAuditContext: vi.fn(() => ({ actor: "test-admin" })),
  recordAdminAuditBestEffort: vi.fn(async () => undefined),
}));

import { PUT as inventoryPUT } from "@/app/api/admin/inventory/route";
import { PATCH as orderStatusPATCH } from "@/app/api/admin/orders/[id]/status/route";
import { PUT as profilePUT } from "@/app/api/account/profile/route";

function putJson(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin mutation + account write rate limits (60/min)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminUpdateInventory.mockResolvedValue({ ok: true });
    mockAdminUpdateOrderStatus.mockResolvedValue({ ok: true });
    mockUpdateProfile.mockResolvedValue({ ok: true });
  });

  it("limits admin inventory writes to 60/min per admin with 429 + Retry-After", async () => {
    mockRequireAdmin.mockResolvedValue({ id: "admin-rl-inventory", email: "a@example.invalid", role: "ADMIN" });
    for (let i = 0; i < 60; i++) {
      const res = await inventoryPUT(putJson("/api/admin/inventory", { productId: "p1", quantity: 5 }));
      expect(res.status).toBe(200);
    }
    const limited = await inventoryPUT(putJson("/api/admin/inventory", { productId: "p1", quantity: 5 }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await limited.json()) as { error: string }).toMatchObject({ error: expect.stringMatching(/try again in \d+s/) });
    // A different admin still has their own budget.
    mockRequireAdmin.mockResolvedValue({ id: "admin-rl-inventory-2", email: "b@example.invalid", role: "ADMIN" });
    const other = await inventoryPUT(putJson("/api/admin/inventory", { productId: "p1", quantity: 5 }));
    expect(other.status).toBe(200);
  });

  it("limits admin order-status writes to 60/min per admin", async () => {
    mockRequireAdmin.mockResolvedValue({ id: "admin-rl-orders", email: "a@example.invalid", role: "ADMIN" });
    const ctx = { params: Promise.resolve({ id: "order-1" }) };
    const patch = () =>
      orderStatusPATCH(
        new Request("http://localhost/api/admin/orders/order-1/status", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "CONFIRMED" }),
        }),
        ctx
      );
    for (let i = 0; i < 60; i++) {
      expect((await patch()).status).toBe(200);
    }
    const limited = await patch();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("limits account profile writes to 60/min per user", async () => {
    mockRequireUser.mockResolvedValue({ id: "user-rl-profile", email: "u@example.invalid", role: "CUSTOMER" });
    for (let i = 0; i < 60; i++) {
      const res = await profilePUT(putJson("/api/account/profile", { name: "Test User" }));
      expect(res.status).toBe(200);
    }
    const limited = await profilePUT(putJson("/api/account/profile", { name: "Test User" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
