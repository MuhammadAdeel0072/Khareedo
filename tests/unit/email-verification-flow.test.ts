import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockSendVerificationEmail, mockFindUserByEmail, mockEnqueueVerificationEmail } = vi.hoisted(() => ({
  mockDb: { $transaction: vi.fn() },
  mockSendVerificationEmail: vi.fn(),
  mockFindUserByEmail: vi.fn(),
  mockEnqueueVerificationEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/services/email.service", () => ({
  sendVerificationEmail: mockSendVerificationEmail,
}));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mockFindUserByEmail,
}));
vi.mock("@/services/email-outbox.service", () => ({
  enqueueVerificationEmail: mockEnqueueVerificationEmail,
}));

import {
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
    mockEnqueueVerificationEmail.mockReset();
  });

  it("registration only enqueues a verification email — the worker generates the token and sends it", async () => {
    // Phase 3 Chunk 7 (M-24): registration no longer sends synchronously,
    // so a transient SMTP failure cannot fail registration. It enqueues one
    // outbox row carrying only the email; the worker looks the account up,
    // generates the token at delivery time, stores only its hash, and sends
    // the link (proved in email-outbox.test.ts). No token is created here
    // and no email is sent here.
    await sendRegistrationVerification(
      { id: "customer-1", email: "customer@example.com", name: "Customer" }
    );

    expect(mockEnqueueVerificationEmail).toHaveBeenCalledTimes(1);
    expect(mockEnqueueVerificationEmail).toHaveBeenCalledWith({
      email: "customer@example.com",
      // Chunk 7-final: the outbox payload carries the callbackUrl so the
      // delivered verification link lands where the customer was going.
      callbackUrl: null,
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it("threads a callbackUrl through registration into the outbox payload", async () => {
    await sendRegistrationVerification(
      { id: "customer-1", email: "customer@example.com", name: "Customer" },
      "/checkout"
    );

    expect(mockEnqueueVerificationEmail).toHaveBeenCalledTimes(1);
    expect(mockEnqueueVerificationEmail).toHaveBeenCalledWith({
      email: "customer@example.com",
      callbackUrl: "/checkout",
    });
  });

  it("resend enqueues without an account lookup — the worker discards ineligible addresses", async () => {
    // Phase 3 Chunk 7 (M-24): resend also goes through the outbox. The
    // service performs NO account lookup, so the request path cannot branch
    // on account existence; the worker discards unknown, OAuth-only, and
    // already-verified addresses after the request returns.
    await resendVerificationEmail("customer@example.com");

    expect(mockFindUserByEmail).not.toHaveBeenCalled();
    expect(mockEnqueueVerificationEmail).toHaveBeenCalledTimes(1);
    expect(mockEnqueueVerificationEmail).toHaveBeenCalledWith({
      email: "customer@example.com",
      // Chunk 7-final: the outbox payload carries the callbackUrl so the
      // delivered verification link lands where the customer was going.
      callbackUrl: null,
    });
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
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
