// Integration test — password reset end to end against a throwaway SQLite
// database (PR-09). Run with: npm run test:db
//
// Covers the full flow with the real Prisma layer: request a reset (token
// stored hashed, raw token emailed once), redeem it (password changes,
// passwordChangedAt is recorded, token is consumed), and prove the old
// password no longer works, the new one does, and the token cannot be reused.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const sentTokens: string[] = [];

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

vi.mock("@/services/email.service", () => ({
  sendPasswordResetEmail: vi.fn(async ({ token }: { token: string }) => {
    sentTokens.push(token);
  }),
}));

import { db } from "@/lib/db";
import { requestPasswordReset, resetPasswordWithToken } from "@/services/password-reset.service";
import { hashPasswordResetToken } from "@/services/password-reset.service";

// These tests run only through the disposable SQLite test harness. They
// exercise the real Prisma layer and never use the application's configured
// database.
assertDisposableTestDatabase();

const OLD_PASSWORD = "OldPassword123";
const NEW_PASSWORD = "NewPassword456";
let userId = "";
let userEmail = "";

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  userEmail = `reset-test-${suffix}@example.invalid`;
  const user = await db.user.create({
    data: {
      email: userEmail,
      name: "Reset Test",
      passwordHash: await bcrypt.hash(OLD_PASSWORD, 12),
      emailVerified: new Date(),
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.passwordResetToken.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("password reset (integration)", () => {
  it("resets the password end to end and invalidates the old one", async () => {
    // Request a reset: one token row is stored (hashed) and the raw token
    // is emailed once.
    await requestPasswordReset(userEmail);
    expect(sentTokens).toHaveLength(1);
    const rawToken = sentTokens[0];
    const stored = await db.passwordResetToken.findUnique({
      where: { tokenHash: hashPasswordResetToken(rawToken) },
    });
    expect(stored).not.toBeNull();
    expect(stored!.userId).toBe(userId);
    expect(stored!.email).toBe(userEmail);
    expect(stored!.consumedAt).toBeNull();
    // The raw token is never stored — only its hash.
    expect(stored!.tokenHash).not.toContain(rawToken);

    // Redeem the token: password changes and passwordChangedAt is recorded.
    const result = await resetPasswordWithToken(rawToken, NEW_PASSWORD);
    expect(result).toEqual({ id: userId, email: userEmail, name: "Reset Test", role: "CUSTOMER" });

    const updatedUser = await db.user.findUnique({ where: { id: userId } });
    expect(updatedUser).not.toBeNull();
    expect(await bcrypt.compare(NEW_PASSWORD, updatedUser!.passwordHash!)).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, updatedUser!.passwordHash!)).toBe(false);
    expect(updatedUser!.passwordChangedAt).not.toBeNull();

    // The token is consumed.
    const consumed = await db.passwordResetToken.findUnique({
      where: { tokenHash: hashPasswordResetToken(rawToken) },
    });
    expect(consumed!.consumedAt).not.toBeNull();

    // The same token cannot be used again.
    expect(await resetPasswordWithToken(rawToken, "AnotherPass789")).toBeNull();
  });

  it("a verification token cannot reset a password (separate tables)", async () => {
    // Create an email-verification token for the same user and try to
    // redeem it as a password reset token. It must not match anything in
    // the password-reset table.
    const { randomBytes, createHash } = await import("node:crypto");
    const verificationToken = randomBytes(32).toString("base64url");
    const verificationHash = createHash("sha256").update(verificationToken).digest("hex");
    await db.verificationToken.create({
      data: {
        userId,
        email: userEmail,
        tokenHash: verificationHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    expect(await resetPasswordWithToken(verificationToken, "AnotherPass789")).toBeNull();

    // The password is unchanged by the failed attempt.
    const user = await db.user.findUnique({ where: { id: userId } });
    expect(await bcrypt.compare(NEW_PASSWORD, user!.passwordHash!)).toBe(true);
  });

  it("requesting a reset for an unknown email creates no token", async () => {
    const before = await db.passwordResetToken.count();
    await requestPasswordReset("nobody-at-all@example.invalid");
    const after = await db.passwordResetToken.count();
    expect(after).toBe(before);
  });
});
