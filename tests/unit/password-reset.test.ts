// Password reset service tests (PR-09).
//
// The reset flow mirrors the email-verification token pattern: a
// cryptographically secure random token, only its SHA-256 hash stored,
// single-use (consumedAt) and expiring. The raw token is emailed once and
// never persisted. A successful reset sets passwordChangedAt so the auth
// guard invalidates sessions issued before the reset (NextAuth v4 JWTs are
// not revocable).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockSendPasswordResetEmail, mockFindUserByEmail } = vi.hoisted(() => ({
  mockDb: { $transaction: vi.fn() },
  mockSendPasswordResetEmail: vi.fn(),
  mockFindUserByEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/services/email.service", () => ({
  sendPasswordResetEmail: mockSendPasswordResetEmail,
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
    mockSendPasswordResetEmail.mockReset();
    mockFindUserByEmail.mockReset();
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

  it("requesting a reset for a credentials account creates one token and emails it", async () => {
    mockFindUserByEmail.mockResolvedValue(customer);
    let createdData: { tokenHash: string; expiresAt: Date } | null = null;
    const transaction = {
      passwordResetToken: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: { tokenHash: string; expiresAt: Date } }) => {
          createdData = data;
          return { id: "reset-1", ...data };
        }),
      },
    };
    mockDb.$transaction.mockImplementation((callback: (t: unknown) => unknown) => callback(transaction));

    await requestPasswordReset("customer@example.com");

    expect(mockFindUserByEmail).toHaveBeenCalledWith("customer@example.com");
    expect(transaction.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: customer.id } });
    expect(createdData).not.toBeNull();
    expect(createdData!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // The token expires 1 hour after it is issued.
    expect(createdData!.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(createdData!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    // The raw token is sent by email, never stored.
    expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const sentToken = mockSendPasswordResetEmail.mock.calls[0][0].token as string;
    expect(typeof sentToken).toBe("string");
    expect(sentToken.length).toBeGreaterThan(20);
    expect(hashPasswordResetToken(sentToken)).toBe(createdData!.tokenHash);
  });

  it("requesting a reset for an unknown email does nothing (enumeration-safe)", async () => {
    mockFindUserByEmail.mockResolvedValue(null);

    await requestPasswordReset("nobody@example.com");

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("requesting a reset for an OAuth-only account (no password) does nothing", async () => {
    mockFindUserByEmail.mockResolvedValue({ ...customer, passwordHash: null });

    await requestPasswordReset("customer@example.com");

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("requesting a reset twice replaces the old token (only one valid token)", async () => {
    mockFindUserByEmail.mockResolvedValue(customer);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async ({ data }: { data: unknown }) => ({ id: "reset-2", ...(data as object) }));
    mockDb.$transaction.mockImplementation((callback: (t: unknown) => unknown) =>
      callback({ passwordResetToken: { deleteMany, create } })
    );

    await requestPasswordReset("customer@example.com");
    await requestPasswordReset("customer@example.com");

    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
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
    const create = vi.fn(async ({ data }: { data: unknown }) => ({ id: "reset-admin", ...(data as object) }));
    mockDb.$transaction.mockImplementation((callback: (t: unknown) => unknown) =>
      callback({ passwordResetToken: { deleteMany: vi.fn(async () => ({ count: 0 })), create } })
    );

    await requestPasswordReset("admin@example.com");

    expect(create).toHaveBeenCalledTimes(1);
    expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(mockSendPasswordResetEmail.mock.calls[0][0].email).toBe("admin@example.com");
  });
});
