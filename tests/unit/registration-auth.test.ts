import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { user: { create: vi.fn() } },
  findUserByEmail: vi.fn(),
  sendRegistrationVerification: vi.fn(),
  isEmailDeliveryConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mocks.findUserByEmail,
}));
vi.mock("@/services/email-verification.service", () => ({
  sendRegistrationVerification: mocks.sendRegistrationVerification,
}));
vi.mock("@/services/email.service", () => ({
  EmailDeliveryNotConfiguredError: class EmailDeliveryNotConfiguredError extends Error {},
  isEmailDeliveryConfigured: mocks.isEmailDeliveryConfigured,
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
    mocks.isEmailDeliveryConfigured.mockReturnValue(true);
    mocks.sendRegistrationVerification.mockResolvedValue(undefined);
  });

  it("creates a customer with a password hash and sends one verification email", async () => {
    mocks.findUserByEmail.mockResolvedValue(null);
    mocks.db.user.create.mockImplementation(async ({ data }) => ({
      id: "customer-1",
      email: data.email,
      name: data.name,
    }));

    await expect(registerUser(input, "/checkout")).resolves.toEqual({ ok: true });

    const createCall = mocks.db.user.create.mock.calls[0][0];
    expect(createCall.data.role).toBe("CUSTOMER");
    expect(createCall.data.passwordHash).not.toBe(input.password);
    await expect(bcrypt.compare(input.password, createCall.data.passwordHash)).resolves.toBe(true);
    expect(mocks.sendRegistrationVerification).toHaveBeenCalledTimes(1);
    expect(mocks.sendRegistrationVerification).toHaveBeenCalledWith(
      { id: "customer-1", email: input.email, name: input.name },
      "/checkout"
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
      undefined
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

  it("surfaces email delivery failure and lets the pending account retry", async () => {
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
