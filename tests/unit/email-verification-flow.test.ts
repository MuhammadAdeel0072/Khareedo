import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockSendVerificationEmail, mockFindUserByEmail } = vi.hoisted(() => ({
  mockDb: { $transaction: vi.fn() },
  mockSendVerificationEmail: vi.fn(),
  mockFindUserByEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/services/email.service", () => ({
  sendVerificationEmail: mockSendVerificationEmail,
}));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mockFindUserByEmail,
}));

import {
  hashVerificationToken,
  resendVerificationEmail,
  sendRegistrationVerification,
  verifyEmailTokenForLogin,
} from "@/services/email-verification.service";

const rawToken = "single-use-verification-token";

function setUpToken(overrides: {
  role?: string;
  emailVerified?: Date | null;
  passwordHash?: string | null;
  expiresAt?: Date;
  consumedAt?: Date | null;
} = {}) {
  const user = {
    id: "customer-1",
    email: "customer@example.com",
    name: "Customer",
    image: null,
    role: overrides.role ?? "CUSTOMER",
    emailVerified: overrides.emailVerified ?? null,
    passwordHash:
      overrides.passwordHash === undefined ? "hashed-password" : overrides.passwordHash,
  };
  const record = {
    id: "verification-1",
    userId: user.id,
    email: user.email,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    consumedAt: overrides.consumedAt ?? null,
    user,
  };
  const transaction = {
    verificationToken: {
      findUnique: vi.fn(async () => record),
      updateMany: vi.fn(async ({ where }: { where: { consumedAt: null; expiresAt: { gt: Date } } }) => {
        if (
          record.consumedAt !== null ||
          record.expiresAt.getTime() <= where.expiresAt.gt.getTime()
        ) {
          return { count: 0 };
        }
        record.consumedAt = new Date();
        return { count: 1 };
      }),
    },
    user: {
      updateMany: vi.fn(async () => {
        if (user.emailVerified !== null) return { count: 0 };
        user.emailVerified = new Date();
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => user),
    },
  };

  mockDb.$transaction.mockImplementation((callback) => callback(transaction));
  return { record, user, transaction };
}

describe("verification-token NextAuth exchange", () => {
  beforeEach(() => {
    mockDb.$transaction.mockReset();
    mockSendVerificationEmail.mockReset();
    mockFindUserByEmail.mockReset();
  });

  it("stores only a token hash and sends a link with a safe callback", async () => {
    const transaction = {
      verificationToken: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    mockDb.$transaction.mockImplementation((callback) => callback(transaction));

    await sendRegistrationVerification(
      { id: "customer-1", email: "customer@example.com", name: "Customer" },
      "https://attacker.example/"
    );

    const stored = transaction.verificationToken.create.mock.calls[0][0].data;
    const email = mockSendVerificationEmail.mock.calls[0][0];
    expect(stored.tokenHash).toBe(hashVerificationToken(email.token));
    expect(stored.tokenHash).not.toBe(email.token);
    expect(email.callbackUrl).toBe("/account");
  });

  it("resends only for an unverified password account", async () => {
    mockFindUserByEmail.mockResolvedValue({
      id: "customer-1",
      email: "customer@example.com",
      name: "Customer",
      passwordHash: "stored-hash",
      emailVerified: null,
    });
    const transaction = {
      verificationToken: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    mockDb.$transaction.mockImplementation((callback) => callback(transaction));

    await resendVerificationEmail("customer@example.com", "/checkout");

    expect(mockSendVerificationEmail).toHaveBeenCalledOnce();
    expect(mockSendVerificationEmail.mock.calls[0][0].callbackUrl).toBe("/checkout");
  });

  it("verifies and returns only a customer identity for NextAuth to establish a session", async () => {
    const { user, record } = setUpToken();

    await expect(verifyEmailTokenForLogin(rawToken)).resolves.toEqual({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: "CUSTOMER",
    });
    expect(user.emailVerified).toBeInstanceOf(Date);
    expect(record.consumedAt).toBeInstanceOf(Date);
  });

  it("allows only one successful redemption when requests race", async () => {
    const { record } = setUpToken();

    const results = await Promise.all([
      verifyEmailTokenForLogin(rawToken),
      verifyEmailTokenForLogin(rawToken),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(record.consumedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1) }],
    ["consumed", { consumedAt: new Date() }],
    ["already verified", { emailVerified: new Date() }],
    ["administrator", { role: "ADMIN" }],
    ["OAuth-only", { passwordHash: null }],
  ])("rejects %s tokens without establishing a session", async (_label, overrides) => {
    setUpToken(overrides);

    await expect(verifyEmailTokenForLogin(rawToken)).resolves.toBeNull();
  });
});
