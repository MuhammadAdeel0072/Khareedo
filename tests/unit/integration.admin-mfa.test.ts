// Integration test — admin MFA end to end against a throwaway SQLite
// database (PR-10). Run with: npm run test:db
//
// Covers the full MFA lifecycle with the real Prisma layer: enroll (an
// encrypted secret is stored, MFA not yet enabled), activate (a valid first
// code enables MFA and issues 10 recovery codes whose hashes — not the codes
// themselves — are stored), verify a TOTP code for a session, prove a
// replayed code is rejected, use a recovery code once (and prove the second
// use fails), regenerate recovery codes (old ones stop working), and disable
// MFA with password + code. Customer authentication is unaffected: the
// guard returns MFA-free sessions for customers.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import { totpCodeForStep, totpTimeStep } from "@/lib/totp";

const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

import { db } from "@/lib/db";
import {
  activateAdminMfa,
  decryptTotpSecret,
  disableAdminMfa,
  getAdminMfaStatus,
  regenerateAdminMfaRecoveryCodes,
  startAdminMfaEnrollment,
  verifyAdminMfaForSession,
} from "@/services/admin-mfa.service";

// These tests run only through the disposable SQLite test harness. They
// exercise the real Prisma layer and never use the application's configured
// database.
assertDisposableTestDatabase();

const ADMIN_PASSWORD = "admin-mfa-test-password";
let adminId = "";
let adminEmail = "";

beforeAll(async () => {
  process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  adminEmail = `mfa-admin-${suffix}@example.invalid`;
  const admin = await db.user.create({
    data: {
      email: adminEmail,
      name: "MFA Admin",
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
      emailVerified: new Date(),
      role: "ADMIN",
    },
  });
  adminId = admin.id;
});

afterAll(async () => {
  await db.adminMfaRecoveryCode.deleteMany({ where: { mfa: { userId: adminId } } });
  await db.adminMfa.deleteMany({ where: { userId: adminId } });
  await db.user.deleteMany({ where: { id: adminId } });
  await db.$disconnect();
});

describe("admin MFA lifecycle (integration)", () => {
  it("enrolls, activates, verifies, replays, recovers, regenerates, and disables", async () => {
    // 1. Enroll: a row is created with an encrypted secret, MFA not enabled.
    const enrollment = await startAdminMfaEnrollment({ userId: adminId, email: adminEmail });
    expect(enrollment.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(enrollment.manualKey).toMatch(/^[A-Z2-7]{32}$/);

    let mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa).not.toBeNull();
    expect(mfa!.enabledAt).toBeNull();
    // The stored secret is ciphertext, not the manual key.
    expect(Buffer.from(mfa!.secretEncrypted).toString("utf8")).not.toContain(enrollment.manualKey);
    const key = Buffer.from(TEST_KEY, "base64");
    expect(decryptTotpSecret(mfa!.secretEncrypted, key)).toBe(enrollment.manualKey);

    let status = await getAdminMfaStatus(adminId);
    expect(status).toEqual({
      enrolled: true,
      enabled: false,
      enabledAt: null,
      hasRecoveryCodes: false,
      unusedRecoveryCodes: 0,
    });

    // 2. Activate with a valid first code: MFA is enabled, 10 recovery codes
    // are issued, and only their hashes are stored.
    const step = totpTimeStep();
    const firstCode = totpCodeForStep(enrollment.manualKey, step);
    const recoveryCodes = await activateAdminMfa({ userId: adminId, code: firstCode });
    expect(recoveryCodes).toHaveLength(10);
    mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa!.enabledAt).not.toBeNull();
    const storedCodes = await db.adminMfaRecoveryCode.findMany({ where: { mfaId: mfa!.id } });
    expect(storedCodes).toHaveLength(10);
    expect(storedCodes.every((c) => c.usedAt === null)).toBe(true);
    expect(storedCodes.every((c) => /^[a-f0-9]{64}$/.test(c.codeHash))).toBe(true);
    expect(storedCodes.map((c) => c.codeHash)).not.toEqual(expect.arrayContaining(recoveryCodes!));

    status = await getAdminMfaStatus(adminId);
    expect(status.enabled).toBe(true);
    expect(status.unusedRecoveryCodes).toBe(10);

    // 3. Verify a TOTP code for a session issued before verification.
    const sessionIat = Math.floor(Date.now() / 1000) - 60;
    const verifyStep = totpTimeStep();
    const verifyCode = totpCodeForStep(enrollment.manualKey, verifyStep);
    const verified = await verifyAdminMfaForSession({ userId: adminId, code: verifyCode, sessionIat });
    expect(verified).toBe("verified");
    mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa!.lastVerifiedAt).not.toBeNull();
    expect(mfa!.lastVerifiedAt!.getTime()).toBeGreaterThan(sessionIat * 1000);

    // 4. The same code cannot be replayed. A new session (issued after the
    // first verification, so it is not MFA-verified) must present a fresh
    // code; the replayed code is rejected because its time step was used.
    const newSessionIat = Math.floor(Date.now() / 1000) + 3600;
    const replayed = await verifyAdminMfaForSession({ userId: adminId, code: verifyCode, sessionIat: newSessionIat });
    expect(replayed).toBe("invalid");

    // 5. A recovery code works once, then is consumed. A fresh session (not
    // yet verified) is used so the code is actually checked and consumed.
    const recoveryCode = recoveryCodes![0];
    const recovered = await verifyAdminMfaForSession({ userId: adminId, code: recoveryCode, sessionIat: newSessionIat });
    expect(recovered).toBe("verified");
    const consumed = await db.adminMfaRecoveryCode.findMany({
      where: { mfaId: mfa!.id, usedAt: { not: null } },
    });
    expect(consumed).toHaveLength(1);
    const reused = await verifyAdminMfaForSession({ userId: adminId, code: recoveryCode, sessionIat: newSessionIat });
    expect(reused).toBe("invalid");

    // 6. Regeneration invalidates the old codes and issues fresh ones.
    const freshCodes = await regenerateAdminMfaRecoveryCodes(adminId);
    expect(freshCodes).toHaveLength(10);
    expect(freshCodes).not.toEqual(expect.arrayContaining(recoveryCodes!));
    const oldCodeStillWorks = await verifyAdminMfaForSession({
      userId: adminId,
      code: recoveryCodes![1],
      sessionIat: newSessionIat,
    });
    expect(oldCodeStillWorks).toBe("invalid");
    const freshCodeWorks = await verifyAdminMfaForSession({
      userId: adminId,
      code: freshCodes![0],
      sessionIat: newSessionIat,
    });
    expect(freshCodeWorks).toBe("verified");

    // 7. Disable with the password and a fresh recovery code. (A TOTP code
    // cannot be used here: the test runs inside one 30-second window, so a
    // TOTP code from the current step was already consumed by step 3 and
    // replay protection correctly rejects it.)
    const disabled = await disableAdminMfa({ userId: adminId, password: ADMIN_PASSWORD, code: freshCodes![1] });
    expect(disabled).toBe(true);
    mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa).toBeNull();
    status = await getAdminMfaStatus(adminId);
    expect(status.enrolled).toBe(false);
  });

  it("activation rejects an invalid first code and leaves MFA disabled", async () => {
    await startAdminMfaEnrollment({ userId: adminId, email: adminEmail });
    const codes = await activateAdminMfa({ userId: adminId, code: "000000" });
    expect(codes).toBeNull();
    const mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa!.enabledAt).toBeNull();
    // Clean up so the next test starts fresh.
    await db.adminMfa.delete({ where: { id: mfa!.id } });
  });
});
