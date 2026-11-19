// API route tests for password reset (PR-09, security-review fix):
// POST /api/auth/forgot-password and POST /api/auth/reset-password.
// The service layer is mocked; the real (in-memory) rate limiter is used,
// with a distinct client IP per test so buckets do not leak between tests.
//
// Enumeration safety (security-review fix): the forgot-password route never
// sends email synchronously and never checks SMTP configuration, so its
// response cannot reveal whether an account exists — not through status,
// body, or timing. It enqueues one outbox row and returns the same 200 for
// every address. SMTP failures happen in the background worker and never
// reach this response.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequestPasswordReset, mockResetPasswordWithToken } = vi.hoisted(() => ({
  mockRequestPasswordReset: vi.fn(),
  mockResetPasswordWithToken: vi.fn(),
}));

vi.mock("@/services/password-reset.service", () => ({
  requestPasswordReset: mockRequestPasswordReset,
  resetPasswordWithToken: mockResetPasswordWithToken,
}));

import { POST as forgotPasswordPOST } from "@/app/api/auth/forgot-password/route";
import { POST as resetPasswordPOST } from "@/app/api/auth/reset-password/route";

function postForgot(email: string, ip: string) {
  return forgotPasswordPOST(
    new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
  );
}

function postReset(body: unknown, ip: string) {
  return resetPasswordPOST(
    new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/auth/forgot-password", () => {
  beforeEach(() => {
    mockRequestPasswordReset.mockReset();
    mockResetPasswordWithToken.mockReset();
    mockRequestPasswordReset.mockResolvedValue(undefined);
    // The tests simulate a deployment behind a trusted proxy, so each
    // test's distinct forwarded IP gets its own bucket (Phase 2, area G).
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
  });

  it("returns the same message for an existing account", async () => {
    const res = await postForgot("customer@example.com", "10.0.0.1");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; message: string };
    expect(data.ok).toBe(true);
    expect(data.message).toContain("If an account exists");
    expect(mockRequestPasswordReset).toHaveBeenCalledWith("customer@example.com");
  });

  it("returns the same message for an unknown email (enumeration-safe)", async () => {
    // The service enqueues a no-op row for unknown emails, but the route
    // response is identical — the caller cannot tell the difference.
    const res = await postForgot("nobody@example.com", "10.0.0.2");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; message: string };
    expect(data.ok).toBe(true);
    expect(data.message).toContain("If an account exists");
  });

  it("returns the same 200 for an OAuth-only address (no SMTP check, no 503)", async () => {
    // Regression: the route used to return 503 when SMTP was not configured,
    // but only for registered accounts — a 503 revealed the account exists.
    // The route no longer checks SMTP configuration at all, so it returns
    // 200 for every address regardless of mailer state.
    const res = await postForgot("oauth-only@example.com", "10.0.0.3");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; message: string };
    expect(data.ok).toBe(true);
    expect(data.message).toContain("If an account exists");
    expect(mockRequestPasswordReset).toHaveBeenCalledWith("oauth-only@example.com");
  });

  it("rejects an invalid email with 422", async () => {
    const res = await postForgot("not-an-email", "10.0.0.4");
    expect(res.status).toBe(422);
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });

  it("rate-limits repeated requests from one IP (429)", async () => {
    const ip = "10.0.0.5";
    for (let i = 0; i < 10; i++) {
      const res = await postForgot(`user${i}@example.com`, ip);
      expect(res.status).toBe(200);
    }
    const limited = await postForgot("user10@example.com", ip);
    expect(limited.status).toBe(429);
  });

  it("rate-limits repeated requests for one email address (429)", async () => {
    const email = "target@example.com";
    for (let i = 0; i < 3; i++) {
      const res = await postForgot(email, `10.0.1.${i}`);
      expect(res.status).toBe(200);
    }
    const limited = await postForgot(email, "10.0.1.99");
    expect(limited.status).toBe(429);
  });
});

describe("POST /api/auth/reset-password", () => {
  beforeEach(() => {
    mockRequestPasswordReset.mockReset();
    mockResetPasswordWithToken.mockReset();
    // Same trusted-proxy simulation as the forgot-password describe.
    process.env.TRUSTED_PROXY_IPS = "10.0.0.1";
  });

  it("resets the password with a valid token", async () => {
    mockResetPasswordWithToken.mockResolvedValue({ id: "u1", email: "customer@example.com", name: "Customer", role: "CUSTOMER" });
    const res = await postReset({ token: "valid-token", password: "NewPassword123" }, "10.0.0.11");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; message: string };
    expect(data.ok).toBe(true);
    expect(data.message).toContain("has been reset");
    expect(mockResetPasswordWithToken).toHaveBeenCalledWith("valid-token", "NewPassword123");
  });

  it("rejects an invalid, expired, or already-used token with the same 400", async () => {
    mockResetPasswordWithToken.mockResolvedValue(null);
    const res = await postReset({ token: "bad-token", password: "NewPassword123" }, "10.0.0.12");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toContain("invalid or has expired");
  });

  it("rejects a too-short password with 422 and never calls the service", async () => {
    const res = await postReset({ token: "valid-token", password: "short" }, "10.0.0.13");
    expect(res.status).toBe(422);
    expect(mockResetPasswordWithToken).not.toHaveBeenCalled();
  });

  it("rejects a missing token with 422", async () => {
    const res = await postReset({ password: "NewPassword123" }, "10.0.0.14");
    expect(res.status).toBe(422);
    expect(mockResetPasswordWithToken).not.toHaveBeenCalled();
  });

  it("rate-limits repeated redemption attempts from one IP (429)", async () => {
    mockResetPasswordWithToken.mockResolvedValue(null);
    const ip = "10.0.0.15";
    for (let i = 0; i < 10; i++) {
      const res = await postReset({ token: `guess-${i}`, password: "NewPassword123" }, ip);
      expect(res.status).toBe(400);
    }
    const limited = await postReset({ token: "guess-10", password: "NewPassword123" }, ip);
    expect(limited.status).toBe(429);
  });
});
