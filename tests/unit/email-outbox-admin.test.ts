// Admin email-outbox routes (Phase 3 Chunk 7, H-15 / M-23): retry a FAILED
// row and trigger an on-demand delivery sweep. Both require an MFA-verified
// admin session and are rate-limited per admin.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TestAuthError extends Error {
    constructor(public readonly status: number) {
      super("Access denied");
    }
  }

  return {
    TestAuthError,
    requireAdminMfaVerified: vi.fn(),
    rateLimit: vi.fn(),
    retryEmailOutboxEntry: vi.fn(),
    deliverPendingOutboxEmails: vi.fn(),
    recordAdminAuditBestEffort: vi.fn(),
  };
});

vi.mock("@/lib/auth-guard", () => ({
  requireAdminMfaVerified: mocks.requireAdminMfaVerified,
  AuthError: mocks.TestAuthError,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/services/email-outbox.service", () => ({
  retryEmailOutboxEntry: mocks.retryEmailOutboxEntry,
  deliverPendingOutboxEmails: mocks.deliverPendingOutboxEmails,
}));

vi.mock("@/services/admin-audit.service", () => ({
  ADMIN_AUDIT_ACTIONS: {
    EMAIL_OUTBOX_RETRIED: "admin.email.outbox_retried",
    EMAIL_OUTBOX_DELIVERY_RUN: "admin.email.outbox_delivery_run",
  },
  adminAuditContext: vi.fn(() => ({ adminUserId: "admin-1", ipAddress: "127.0.0.1" })),
  recordAdminAuditBestEffort: mocks.recordAdminAuditBestEffort,
}));

import { POST as retryPost } from "@/app/api/admin/email-outbox/[id]/retry/route";
import { POST as deliverPost } from "@/app/api/admin/email-outbox/deliver/route";

const admin = { id: "admin-1", role: "ADMIN" };

describe("admin email-outbox retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminMfaVerified.mockResolvedValue(admin);
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
  });

  it("retries a FAILED row and audits the action", async () => {
    mocks.retryEmailOutboxEntry.mockResolvedValue(true);

    const response = await retryPost(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: "row-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, retried: true });
    expect(mocks.retryEmailOutboxEntry).toHaveBeenCalledWith("row-1");
    expect(mocks.recordAdminAuditBestEffort).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAuditBestEffort.mock.calls[0][1].action).toBe(
      "admin.email.outbox_retried"
    );
  });

  it("returns 404 when the row is missing or not FAILED", async () => {
    mocks.retryEmailOutboxEntry.mockResolvedValue(false);

    const response = await retryPost(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: "row-1" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.recordAdminAuditBestEffort).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests and rate-limited ones", async () => {
    mocks.requireAdminMfaVerified.mockRejectedValue(new mocks.TestAuthError(401));
    const unauthenticated = await retryPost(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: "row-1" }),
    });
    expect(unauthenticated.status).toBe(401);

    mocks.requireAdminMfaVerified.mockResolvedValue(admin);
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfterSec: 30 });
    const limited = await retryPost(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: "row-1" }),
    });
    expect(limited.status).toBe(429);
    expect(mocks.retryEmailOutboxEntry).not.toHaveBeenCalled();
  });
});

describe("admin email-outbox deliver route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminMfaVerified.mockResolvedValue(admin);
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfterSec: 0 });
  });

  it("runs one delivery sweep and returns the counts", async () => {
    const result = { considered: 2, delivered: 1, discarded: 1, failed: 0, permanentlyFailed: 0 };
    mocks.deliverPendingOutboxEmails.mockResolvedValue(result);

    const response = await deliverPost(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch: 5 }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining(result));
    expect(mocks.deliverPendingOutboxEmails).toHaveBeenCalledWith(5);
    expect(mocks.recordAdminAuditBestEffort).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAuditBestEffort.mock.calls[0][1].action).toBe(
      "admin.email.outbox_delivery_run"
    );
  });

  it("defaults the batch to 10 and rejects an invalid body", async () => {
    mocks.deliverPendingOutboxEmails.mockResolvedValue({
      considered: 0, delivered: 0, discarded: 0, failed: 0, permanentlyFailed: 0,
    });

    const empty = await deliverPost(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(empty.status).toBe(200);
    expect(mocks.deliverPendingOutboxEmails).toHaveBeenCalledWith(10);

    const invalid = await deliverPost(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batch: 500 }),
      })
    );
    expect(invalid.status).toBe(422);
  });

  it("rejects unauthenticated requests", async () => {
    mocks.requireAdminMfaVerified.mockRejectedValue(new mocks.TestAuthError(403));

    const response = await deliverPost(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.deliverPendingOutboxEmails).not.toHaveBeenCalled();
  });
});
