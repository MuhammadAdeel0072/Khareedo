import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { user: { create: vi.fn() } },
  findUserByEmail: vi.fn(),
  sendRegistrationVerification: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mocks.findUserByEmail,
}));
vi.mock("@/services/email-verification.service", () => ({
  sendRegistrationVerification: mocks.sendRegistrationVerification,
}));

import bcrypt from "bcryptjs";
import { registerUser } from "@/services/users.service";

const input = {
  name: "Test Customer",
  email: "customer@example.com",
  password: "a-strong-password",
};

describe("customer registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendRegistrationVerification.mockResolvedValue(undefined);
  });

  it("creates a customer with a password hash and enqueues one verification email", async () => {
    mocks.findUserByEmail.mockResolvedValue(null);
    mocks.db.user.create.mockImplementation(async ({ data }) => ({
      id: "customer-1",
      email: data.email,
      name: data.name,
    }));

    // Phase 3 Chunk 7 (M-24): registration only enqueues the verification
    // email in the outbox — it never sends synchronously and never checks
    // SMTP configuration, so it succeeds whether or not SMTP is reachable.
    await expect(registerUser(input)).resolves.toEqual({ ok: true });

    const createCall = mocks.db.user.create.mock.calls[0][0];
    expect(createCall.data.role).toBe("CUSTOMER");
    expect(createCall.data.passwordHash).not.toBe(input.password);
    await expect(bcrypt.compare(input.password, createCall.data.passwordHash)).resolves.toBe(true);
    expect(mocks.sendRegistrationVerification).toHaveBeenCalledTimes(1);
    expect(mocks.sendRegistrationVerification).toHaveBeenCalledWith(
      { id: "customer-1", email: input.email, name: input.name },
      // Chunk 7-final: no callbackUrl was supplied, so null is threaded.
      null
    );
  });

  it("resends a verification email for an existing unverified password account", async () => {
    const existing = {
      id: "customer-1",
      email: input.email,
      name: input.name,
      passwordHash: "existing-password-hash",
      emailVerified: null,
    };
    mocks.findUserByEmail.mockResolvedValue(existing);

    await expect(registerUser(input)).resolves.toEqual({ ok: true });

    expect(mocks.db.user.create).not.toHaveBeenCalled();
    expect(mocks.sendRegistrationVerification).toHaveBeenCalledTimes(1);
    expect(mocks.sendRegistrationVerification).toHaveBeenCalledWith(
      { id: existing.id, email: existing.email, name: existing.name },
      // Chunk 7-final: no callbackUrl was supplied, so null is threaded.
      null
    );
  });

  it("does not resend a registration email for an already verified account", async () => {
    mocks.findUserByEmail.mockResolvedValue({
      id: "customer-1",
      email: input.email,
      name: input.name,
      passwordHash: "existing-password-hash",
      emailVerified: new Date(),
    });

    await expect(registerUser(input)).resolves.toEqual({ ok: true });

    expect(mocks.db.user.create).not.toHaveBeenCalled();
    expect(mocks.sendRegistrationVerification).not.toHaveBeenCalled();
  });

  it("surfaces a verification-enqueue failure and lets the pending account retry", async () => {
    // The enqueue (not an SMTP send) is what can still fail here — e.g. the
    // database is unreachable. The user was already created, so the retry
    // finds the existing unverified account and enqueues again; the user is
    // never created twice.
    const createdUser = { id: "customer-1", email: input.email, name: input.name };
    mocks.findUserByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...createdUser,
        passwordHash: "stored-hash",
        emailVerified: null,
      });
    mocks.db.user.create.mockResolvedValue(createdUser);
    mocks.sendRegistrationVerification
      .mockRejectedValueOnce(new Error("delivery unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(registerUser(input)).rejects.toThrow("delivery unavailable");
    await expect(registerUser(input)).resolves.toEqual({ ok: true });

    expect(mocks.db.user.create).toHaveBeenCalledTimes(1);
    expect(mocks.sendRegistrationVerification).toHaveBeenCalledTimes(2);
  });
});
