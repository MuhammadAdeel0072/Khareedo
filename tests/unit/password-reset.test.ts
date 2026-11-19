// Password reset service tests (PR-09, security-review fix).
//
// The reset flow mirrors the email-verification token pattern: a
// cryptographically secure random token, only its SHA-256 hash stored,
// single-use (consumedAt) and expiring. The raw token is emailed once and
// never persisted. A successful reset sets passwordChangedAt so the auth
// guard invalidates sessions issued before the reset (NextAuth v4 JWTs are
// not revocable).
//
// Enumeration safety (security-review fix): requestPasswordReset enqueues
// exactly one outbox row — the same single DB write for every address —
// and never sends email synchronously. A background worker generates the
// token at delivery time and sends the email, so SMTP failures and delivery
// timing can never reveal whether an account exists.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockEnqueuePasswordResetEmail, mockFindUserByEmail } = vi.hoisted(() => ({
  mockDb: { $transaction: vi.fn() },
  mockEnqueuePasswordResetEmail: vi.fn(),
  mockFindUserByEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/services/email-outbox.service", () => ({
  enqueuePasswordResetEmail: mockEnqueuePasswordResetEmail,
}));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mockFindUserByEmail,
}));
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn(async () => "new-hashed-password") },
}));

import {
  PASSWORD_RESET_TOKEN_TTL_MS,
  hashPasswordResetToken,
  isPasswordResetTokenUsable,
  requestPasswordReset,
  resetPasswordWithToken,
} from "@/services/password-reset.service";

const customer = {
  id: "customer-1",
  email: "customer@example.com",
  name: "Customer",
  passwordHash: "old-hashed-password",
  role: "CUSTOMER",
};

const admin = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Admin",
  passwordHash: "admin-hashed-password",
  role: "ADMIN",
};

function setUpResetToken(overrides: {
  expiresAt?: Date;
  consumedAt?: Date | null;
  passwordHash?: string | null;
} = {}) {
  const record = {
    id: "reset-1",
    userId: customer.id,
    email: customer.email,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    consumedAt: overrides.consumedAt ?? null,
    user: {
      ...customer,
      passwordHash: overrides.passwordHash === undefined ? customer.passwordHash : overrides.passwordHash,
    },
  };
  const transaction = {
    passwordResetToken: {
      findUnique: vi.fn(async () => record),
      updateMany: vi.fn(async ({ where }: { where: { consumedAt: null; expiresAt: { gt: Date } } }) => {
        if (record.consumedAt !== null || record.expiresAt.getTime() <= where.expiresAt.gt.getTime()) {
          return { count: 0 };
        }
        record.consumedAt = new Date();
        return { count: 1 };
      }),
    },
    user: {
      updateMany: vi.fn(async () => {
        if (record.user.passwordHash === null) return { count: 0 };
        record.user.passwordHash = "new-hashed-password";
        return { count: 1 };
      }),
    },
  };
  mockDb.$transaction.mockImplementation((callback: (t: unknown) => unknown) => callback(transaction));
  return { record, transaction };
}

describe("password reset tokens", () => {
  beforeEach(() => {
    mockDb.$transaction.mockReset();
    mockEnqueuePasswordResetEmail.mockReset();
    mockFindUserByEmail.mockReset();
    mockEnqueuePasswordResetEmail.mockResolvedValue(undefined);
  });

  it("hashes tokens deterministically (same token, same hash)", () => {
    expect(hashPasswordResetToken("abc")).toBe(hashPasswordResetToken("abc"));
    expect(hashPasswordResetToken("abc")).not.toBe(hashPasswordResetToken("abd"));
    // The stored value is a hex SHA-256 digest, never the raw token.
    expect(hashPasswordResetToken("abc")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reset tokens expire after 1 hour", () => {
    expect(PASSWORD_RESET_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("a token is usable only while unconsumed and unexpired", () => {
    const now = new Date();
    expect(isPasswordResetTokenUsable({ expiresAt: new Date(now.getTime() + 60_000), consumedAt: null }, now)).toBe(true);
    expect(isPasswordResetTokenUsable({ expiresAt: new Date(now.getTime() - 1_000), consumedAt: null }, now)).toBe(false);
    expect(isPasswordResetTokenUsable({ expiresAt: new Date(now.getTime() + 60_000), consumedAt: now }, now)).toBe(false);
  });

  it("requesting a reset for a credentials account enqueues one outbox row (no token, no email yet)", async () => {
    mockFindUserByEmail.mockResolvedValue(customer);

    await requestPasswordReset("customer@example.com");

    expect(mockFindUserByEmail).toHaveBeenCalledWith("customer@example.com");
    // Exactly one outbox row, carrying the userId so the worker can deliver.
    // No token is created here and no email is sent here — the worker does
    // both at delivery time.
    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledWith({
      userId: customer.id,
      email: "customer@example.com",
      name: "Customer",
    });
    // The service never touches the token table or the mailer directly.
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("requesting a reset for an unknown email enqueues the same single no-op row (indistinguishable)", async () => {
    mockFindUserByEmail.mockResolvedValue(null);

    await requestPasswordReset("nobody@example.com");

    // Same observable work as for a registered account: exactly one outbox
    // row. The row carries no userId, so the worker discards it without
    // sending anything — but the endpoint's DB write is identical.
    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledWith({
      userId: null,
      email: "nobody@example.com",
      name: null,
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("requesting a reset for an OAuth-only account (no password) enqueues the same single no-op row", async () => {
    mockFindUserByEmail.mockResolvedValue({ ...customer, passwordHash: null });

    await requestPasswordReset("customer@example.com");

    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledWith({
      userId: null,
      email: "customer@example.com",
      name: "Customer",
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("requesting a reset twice enqueues two rows (the worker dedups tokens at delivery)", async () => {
    mockFindUserByEmail.mockResolvedValue(customer);

    await requestPasswordReset("customer@example.com");
    await requestPasswordReset("customer@example.com");

    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledTimes(2);
  });

  it("a valid token resets the password, consumes the token, and returns the user", async () => {
    const { record } = setUpResetToken();

    const result = await resetPasswordWithToken("raw-reset-token", "NewPassword123");

    expect(result).toEqual({ id: customer.id, email: customer.email, name: customer.name, role: "CUSTOMER" });
    expect(record.consumedAt).not.toBeNull();
    expect(record.user.passwordHash).toBe("new-hashed-password");
  });

  it("a token cannot be reused (single-use)", async () => {
    const { record } = setUpResetToken();
    await resetPasswordWithToken("raw-reset-token", "NewPassword123");
    expect(record.consumedAt).not.toBeNull();

    // Second redemption with the same token fails.
    const result = await resetPasswordWithToken("raw-reset-token", "AnotherPass123");
    expect(result).toBeNull();
  });

  it("an expired token cannot reset the password", async () => {
    setUpResetToken({ expiresAt: new Date(Date.now() - 1_000) });

    const result = await resetPasswordWithToken("raw-reset-token", "NewPassword123");
    expect(result).toBeNull();
  });

  it("an already-consumed token cannot reset the password", async () => {
    setUpResetToken({ consumedAt: new Date() });

    const result = await resetPasswordWithToken("raw-reset-token", "NewPassword123");
    expect(result).toBeNull();
  });

  it("a too-short password is rejected and the token is not consumed", async () => {
    const { record } = setUpResetToken();

    const result = await resetPasswordWithToken("raw-reset-token", "short");
    expect(result).toBeNull();
    expect(record.consumedAt).toBeNull();
  });

  it("an empty or overlong token is rejected", async () => {
    setUpResetToken();
    expect(await resetPasswordWithToken("", "NewPassword123")).toBeNull();
    expect(await resetPasswordWithToken("x".repeat(257), "NewPassword123")).toBeNull();
  });

  it("an admin account can reset its password the same way as a customer", async () => {
    mockFindUserByEmail.mockResolvedValue(admin);

    await requestPasswordReset("admin@example.com");

    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePasswordResetEmail).toHaveBeenCalledWith({
      userId: admin.id,
      email: "admin@example.com",
      name: "Admin",
    });
  });
});
