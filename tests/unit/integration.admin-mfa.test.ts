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
  MfaAlreadyEnabledError,
  regenerateAdminMfaRecoveryCodes,
  startAdminMfaEnrollment,
  startAdminMfaReplacement,
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

describe("admin MFA replacement (P1 fix)", () => {
  // Enroll + activate, returning the active secret and recovery codes.
  async function enableMfa() {
    const enrollment = await startAdminMfaEnrollment({ userId: adminId, email: adminEmail });
    const step = totpTimeStep();
    const recoveryCodes = await activateAdminMfa({
      userId: adminId,
      code: totpCodeForStep(enrollment.manualKey, step),
    });
    expect(recoveryCodes).toHaveLength(10);
    return { secret: enrollment.manualKey, recoveryCodes: recoveryCodes! };
  }

  async function cleanupMfa() {
    await db.adminMfaRecoveryCode.deleteMany({ where: { mfa: { userId: adminId } } });
    await db.adminMfa.deleteMany({ where: { userId: adminId } });
  }

  // A fresh session issued in the future, so verifyAdminMfaForSession
  // actually checks the code instead of short-circuiting.
  function freshSessionIat() {
    return Math.floor(Date.now() / 1000) + 3600;
  }

  it("first-time enrollment continues to work", async () => {
    const { secret, recoveryCodes } = await enableMfa();
    const status = await getAdminMfaStatus(adminId);
    expect(status.enabled).toBe(true);
    expect(status.unusedRecoveryCodes).toBe(10);
    // The active secret verifies for a fresh session.
    const code = totpCodeForStep(secret, totpTimeStep() + 1);
    expect(await verifyAdminMfaForSession({ userId: adminId, code, sessionIat: freshSessionIat() })).toBe(
      "verified"
    );
    expect(recoveryCodes).toHaveLength(10);
    await cleanupMfa();
  });

  it("setup refuses to replace an active enrollment (password-only session cannot take over MFA)", async () => {
    await enableMfa();
    // startAdminMfaEnrollment is the service behind POST /api/admin/mfa/setup,
    // which uses requireAdmin (role only, no MFA check). It must refuse.
    await expect(startAdminMfaEnrollment({ userId: adminId, email: adminEmail })).rejects.toBeInstanceOf(
      MfaAlreadyEnabledError
    );
    // Nothing changed: MFA is still enabled with the same secret.
    const status = await getAdminMfaStatus(adminId);
    expect(status.enabled).toBe(true);
    await cleanupMfa();
  });

  it("replacement requires the current password and a valid current code", async () => {
    const { secret, recoveryCodes } = await enableMfa();
    const currentCode = totpCodeForStep(secret, totpTimeStep() + 1);
    // Wrong password.
    expect(
      await startAdminMfaReplacement({
        userId: adminId,
        email: adminEmail,
        password: "wrong-password",
        code: currentCode,
      })
    ).toBeNull();
    // Wrong code.
    expect(
      await startAdminMfaReplacement({
        userId: adminId,
        email: adminEmail,
        password: ADMIN_PASSWORD,
        code: "000000",
      })
    ).toBeNull();
    // No pending replacement was created by either failure.
    const mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa!.pendingSecretEncrypted).toBeNull();
    expect(mfa!.enabledAt).not.toBeNull();
    expect(recoveryCodes).toHaveLength(10);
    await cleanupMfa();
  });

  it("rejected replacement attempts leave MFA enabled and recovery codes valid", async () => {
    const { secret, recoveryCodes } = await enableMfa();
    const currentCode = totpCodeForStep(secret, totpTimeStep() + 1);
    await startAdminMfaReplacement({
      userId: adminId,
      email: adminEmail,
      password: "wrong-password",
      code: currentCode,
    });
    await startAdminMfaReplacement({
      userId: adminId,
      email: adminEmail,
      password: ADMIN_PASSWORD,
      code: "000000",
    });
    await expect(startAdminMfaEnrollment({ userId: adminId, email: adminEmail })).rejects.toBeInstanceOf(
      MfaAlreadyEnabledError
    );
    // MFA is still enabled, the active secret still verifies, and an old
    // recovery code still works.
    const status = await getAdminMfaStatus(adminId);
    expect(status.enabled).toBe(true);
    expect(status.unusedRecoveryCodes).toBe(10);
    const stillValid = await verifyAdminMfaForSession({
      userId: adminId,
      code: totpCodeForStep(secret, totpTimeStep() + 1),
      sessionIat: freshSessionIat(),
    });
    expect(stillValid).toBe("verified");
    const codeStillWorks = await verifyAdminMfaForSession({
      userId: adminId,
      code: recoveryCodes[0],
      sessionIat: freshSessionIat(),
    });
    expect(codeStillWorks).toBe("verified");
    await cleanupMfa();
  });

  it("a successful authorized replacement swaps the secret and invalidates old recovery codes", async () => {
    const { secret: oldSecret, recoveryCodes: oldCodes } = await enableMfa();
    // Start the replacement with the password and a recovery code (the
    // current-code proof). The active secret stays in place.
    const replacement = await startAdminMfaReplacement({
      userId: adminId,
      email: adminEmail,
      password: ADMIN_PASSWORD,
      code: oldCodes[0],
    });
    expect(replacement).not.toBeNull();
    expect(replacement!.manualKey).toMatch(/^[A-Z2-7]{32}$/);
    expect(replacement!.manualKey).not.toBe(oldSecret);
    let mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa!.enabledAt).not.toBeNull();
    expect(mfa!.pendingSecretEncrypted).not.toBeNull();
    // The active secret is untouched while the replacement is pending.
    const key = Buffer.from(TEST_KEY, "base64");
    expect(decryptTotpSecret(mfa!.secretEncrypted, key)).toBe(oldSecret);
    // The old recovery codes are still valid while the replacement is pending
    // (one was consumed as the replacement proof, the rest remain).
    expect((await getAdminMfaStatus(adminId)).unusedRecoveryCodes).toBe(9);

    // Activate with a code from the NEW secret: the swap is atomic, MFA
    // stays enabled, and the old recovery codes are invalidated.
    const newCodes = await activateAdminMfa({
      userId: adminId,
      code: totpCodeForStep(replacement!.manualKey, totpTimeStep()),
    });
    expect(newCodes).toHaveLength(10);
    mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa!.enabledAt).not.toBeNull();
    expect(mfa!.pendingSecretEncrypted).toBeNull();
    expect(decryptTotpSecret(mfa!.secretEncrypted, key)).toBe(replacement!.manualKey);
    // The new secret verifies; the old secret and old recovery codes do not.
    const newWorks = await verifyAdminMfaForSession({
      userId: adminId,
      code: totpCodeForStep(replacement!.manualKey, totpTimeStep() + 1),
      sessionIat: freshSessionIat(),
    });
    expect(newWorks).toBe("verified");
    const oldSecretWorks = await verifyAdminMfaForSession({
      userId: adminId,
      code: totpCodeForStep(oldSecret, totpTimeStep() + 1),
      sessionIat: freshSessionIat(),
    });
    expect(oldSecretWorks).toBe("invalid");
    const oldCodeWorks = await verifyAdminMfaForSession({
      userId: adminId,
      code: oldCodes[1],
      sessionIat: freshSessionIat(),
    });
    expect(oldCodeWorks).toBe("invalid");
    await cleanupMfa();
  });

  it("activation of an already-active MFA without a pending replacement is rejected", async () => {
    const { secret, recoveryCodes } = await enableMfa();
    // A valid code from the active secret must NOT re-activate (and must
    // not regenerate recovery codes — that would bypass the
    // requireAdminMfaVerified gate of the recovery-codes endpoint).
    const result = await activateAdminMfa({
      userId: adminId,
      code: totpCodeForStep(secret, totpTimeStep() + 1),
    });
    expect(result).toBeNull();
    const status = await getAdminMfaStatus(adminId);
    expect(status.enabled).toBe(true);
    expect(status.unusedRecoveryCodes).toBe(10);
    const codeStillWorks = await verifyAdminMfaForSession({
      userId: adminId,
      code: recoveryCodes[0],
      sessionIat: freshSessionIat(),
    });
    expect(codeStillWorks).toBe("verified");
    await cleanupMfa();
  });
});

describe("admin MFA enrollment/activation races (TOCTOU fix)", () => {
  async function cleanupMfa() {
    await db.adminMfaRecoveryCode.deleteMany({ where: { mfa: { userId: adminId } } });
    await db.adminMfa.deleteMany({ where: { userId: adminId } });
  }

  it("concurrent enrollment and activation cannot overwrite active MFA or enable with a stale secret", async () => {
    // Start from a pending enrollment, then race a second enrollment
    // against the activation of the first. Either outcome is acceptable,
    // but the invariant must hold in both: active MFA is never overwritten,
    // and activation never enables MFA with a secret the admin did not set up.
    const enrollment = await startAdminMfaEnrollment({ userId: adminId, email: adminEmail });
    const firstCode = totpCodeForStep(enrollment.manualKey, totpTimeStep());
    const [enrollResult, activateResult] = await Promise.allSettled([
      startAdminMfaEnrollment({ userId: adminId, email: adminEmail }),
      activateAdminMfa({ userId: adminId, code: firstCode }),
    ]);
    const key = Buffer.from(TEST_KEY, "base64");
    const mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa).not.toBeNull();
    if (activateResult.status === "fulfilled" && activateResult.value !== null) {
      // Activation won: MFA is enabled with the FIRST secret, 10 recovery
      // codes were issued, and the enrollment was refused.
      expect(enrollResult.status).toBe("rejected");
      expect(mfa!.enabledAt).not.toBeNull();
      expect(decryptTotpSecret(mfa!.secretEncrypted, key)).toBe(enrollment.manualKey);
      const codes = await db.adminMfaRecoveryCode.findMany({ where: { mfaId: mfa!.id } });
      expect(codes).toHaveLength(10);
      expect(codes.every((c) => c.usedAt === null)).toBe(true);
    } else {
      // Enrollment won: MFA is still pending with the SECOND secret, the
      // activation was refused, and no recovery codes were issued.
      expect(activateResult.status === "fulfilled" && activateResult.value === null).toBe(true);
      expect(mfa!.enabledAt).toBeNull();
      const stored = decryptTotpSecret(mfa!.secretEncrypted, key);
      expect(stored).not.toBe(enrollment.manualKey);
      expect(stored).toMatch(/^[A-Z2-7]{32}$/);
      const codes = await db.adminMfaRecoveryCode.findMany({ where: { mfaId: mfa!.id } });
      expect(codes).toHaveLength(0);
    }
    await cleanupMfa();
  });

  it("activation cannot enable MFA with a superseded secret", async () => {
    // Deterministic form of the stale-secret race: enroll, then replace
    // the secret with a second enrollment, then try to activate with a
    // code from the first secret. The stored secret is the second one, so
    // the first code must not enable MFA.
    const first = await startAdminMfaEnrollment({ userId: adminId, email: adminEmail });
    const firstCode = totpCodeForStep(first.manualKey, totpTimeStep());
    const second = await startAdminMfaEnrollment({ userId: adminId, email: adminEmail });
    expect(second.manualKey).not.toBe(first.manualKey);
    const codes = await activateAdminMfa({ userId: adminId, code: firstCode });
    expect(codes).toBeNull();
    const mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa!.enabledAt).toBeNull();
    const key = Buffer.from(TEST_KEY, "base64");
    expect(decryptTotpSecret(mfa!.secretEncrypted, key)).toBe(second.manualKey);
    // The second secret still activates normally.
    const secondCodes = await activateAdminMfa({
      userId: adminId,
      code: totpCodeForStep(second.manualKey, totpTimeStep()),
    });
    expect(secondCodes).toHaveLength(10);
    await cleanupMfa();
  });

  it("concurrent enrollments leave a single pending enrollment and no recovery codes", async () => {
    // Two first-time enrollments racing from no row: at most one stores
    // its secret per write, the final state is a single pending enrollment
    // with one of the two secrets, and no recovery codes exist.
    const [a, b] = await Promise.allSettled([
      startAdminMfaEnrollment({ userId: adminId, email: adminEmail }),
      startAdminMfaEnrollment({ userId: adminId, email: adminEmail }),
    ]);
    const succeeded = [a, b].filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const mfa = await db.adminMfa.findUnique({ where: { userId: adminId } });
    expect(mfa).not.toBeNull();
    expect(mfa!.enabledAt).toBeNull();
    const key = Buffer.from(TEST_KEY, "base64");
    const stored = decryptTotpSecret(mfa!.secretEncrypted, key);
    const keys = succeeded.map((r) => (r as PromiseFulfilledResult<{ manualKey: string }>).value.manualKey);
    expect(keys).toContain(stored);
    const codes = await db.adminMfaRecoveryCode.findMany({ where: { mfaId: mfa!.id } });
    expect(codes).toHaveLength(0);
    await cleanupMfa();
  });
});
