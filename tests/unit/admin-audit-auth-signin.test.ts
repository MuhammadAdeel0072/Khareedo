import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression tests for the PR-12 review finding: the NextAuth signIn event
// in src/lib/auth.ts used to call recordAdminAudit() inside a try/catch
// with an empty catch, so a failed audit write was silently discarded.
// The handler now uses recordAdminAuditBestEffort(), which reports the
// failure through error monitoring (captureError, AUDIT_WRITE_FAILED)
// and can never throw, so it can never break sign-in.

const mocks = vi.hoisted(() => ({
  adminAuditLogCreate: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { adminAuditLog: { create: mocks.adminAuditLogCreate } },
}));

vi.mock("@/lib/error-monitoring", async importOriginal => {
  const actual =
    await importOriginal<typeof import("@/lib/error-monitoring")>();
  return { ...actual, captureError: mocks.captureError };
});

import { ADMIN_AUDIT_ACTIONS } from "@/services/admin-audit.service";
import { authOptions } from "@/lib/auth";

describe("admin sign-in audit logging (PR-12 review fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function triggerSignIn(user: { id: string; role?: string }) {
    const signIn = authOptions.events?.signIn;
    if (!signIn) throw new Error("signIn event is not configured");
    await signIn({
      user,
      account: null,
      profile: undefined,
      isNewUser: false,
    } as unknown as Parameters<typeof signIn>[0]);
  }

  it("records an admin login audit entry on sign-in", async () => {
    mocks.adminAuditLogCreate.mockResolvedValue({ id: "log-1" });

    await triggerSignIn({
      id: "admin-1",
      role: "ADMIN",
    });

    expect(mocks.adminAuditLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.adminAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminUserId: "admin-1",
        action: ADMIN_AUDIT_ACTIONS.AUTH_ADMIN_LOGIN,
        targetType: "User",
        targetId: "admin-1",
      }),
    });
    expect(mocks.captureError).not.toHaveBeenCalled();
  });

  it("reports a failed audit write through error monitoring and does not break sign-in", async () => {
    mocks.adminAuditLogCreate.mockRejectedValue(
      new Error("database unavailable")
    );

    await expect(
      triggerSignIn({ id: "admin-1", role: "ADMIN" })
    ).resolves.toBeUndefined();

    expect(mocks.captureError).toHaveBeenCalledTimes(1);
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "admin-audit-log",
        code: "AUDIT_WRITE_FAILED",
      })
    );
  });

  it("does not audit non-admin sign-ins", async () => {
    await triggerSignIn({ id: "customer-1", role: "CUSTOMER" });

    expect(mocks.adminAuditLogCreate).not.toHaveBeenCalled();
    expect(mocks.captureError).not.toHaveBeenCalled();
  });
});
