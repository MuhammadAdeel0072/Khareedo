// Admin MFA service tests (PR-10). The DB is mocked; the encryption key is
// a test-only 32-byte base64 key. TOTP codes are computed from the enrolled
// secret (decrypted in-test) so the tests exercise the real crypto path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { totpCodeForStep, totpTimeStep } from "@/lib/totp";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const { mockDb, mockTx } = vi.hoisted(() => {
  // mockTx is the transaction client handed to $transaction callbacks.
  // $transaction executes the callback with mockTx (and propagates a
  // thrown error, as a real transaction rollback would).
  const mockTx = {
    adminMfa: { updateMany: vi.fn() },
    adminMfaRecoveryCode: { createMany: vi.fn(), deleteMany: vi.fn() },
  };
  const mockDb = {
    adminMfa: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    adminMfaRecoveryCode: { createMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
  return { mockDb, mockTx };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") } }));

import {
  activateAdminMfa,
  decryptTotpSecret,
  disableAdminMfa,
  encryptTotpSecret,
  generateRecoveryCode,
  getAdminMfaStatus,
  hashRecoveryCode,
  loadAdminMfaEncryptionKey,
  regenerateAdminMfaRecoveryCodes,
  startAdminMfaEnrollment,
  verifyAdminMfaForSession,
} from "@/services/admin-mfa.service";

const ADMIN_ID = "admin-1";
const ADMIN_EMAIL = "admin@khareedo.pk";

function setTestKey() {
  process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
}

describe("admin MFA service", () => {
  const savedKey = process.env.ADMIN_MFA_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    setTestKey();
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    else process.env.ADMIN_MFA_ENCRYPTION_KEY = savedKey;
  });

  it("loads the encryption key and rejects invalid keys", () => {
    expect(loadAdminMfaEncryptionKey({ ADMIN_MFA_ENCRYPTION_KEY: TEST_KEY })?.byteLength).toBe(32);
    expect(loadAdminMfaEncryptionKey({})).toBeNull();
    expect(loadAdminMfaEncryptionKey({ ADMIN_MFA_ENCRYPTION_KEY: "short" })).toBeNull();
    expect(loadAdminMfaEncryptionKey({ ADMIN_MFA_ENCRYPTION_KEY: "!!!not-base64!!!" })).toBeNull();
  });

  it("encrypts and decrypts a TOTP secret, and detects tampering", () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const encrypted = encryptTotpSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", key);
    expect(decryptTotpSecret(encrypted, key)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    // Tamper with one byte: decryption must fail (auth tag mismatch).
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptTotpSecret(tampered, key)).toThrow();
    // A different key must not decrypt it.
    const otherKey = Buffer.alloc(32, 9);
    expect(() => decryptTotpSecret(encrypted, otherKey)).toThrow();
  });

  it("generates recovery codes in the expected format and hashes them", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(hashRecoveryCode(code)).toBe(createHash("sha256").update(code).digest("hex"));
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode("AAAAA-BBBBB")).not.toBe(hashRecoveryCode("CCCCC-DDDDD"));
  });

  it("reports MFA status for an admin who never enrolled", async () => {
    mockDb.adminMfa.findUnique.mockResolvedValue(null);
    const status = await getAdminMfaStatus(ADMIN_ID);
    expect(status).toEqual({
      enrolled: false,
      enabled: false,
      enabledAt: null,
      hasRecoveryCodes: false,
      unusedRecoveryCodes: 0,
    });
  });

  it("reports MFA status for an enabled admin with unused recovery codes", async () => {
    const enabledAt = new Date("2026-11-19T10:00:00.000Z");
    mockDb.adminMfa.findUnique.mockResolvedValue({
      enabledAt,
      recoveryCodes: [{ usedAt: null }, { usedAt: null }, { usedAt: new Date() }],
    });
    const status = await getAdminMfaStatus(ADMIN_ID);
    expect(status.enrolled).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.enabledAt).toBe(enabledAt);
    expect(status.unusedRecoveryCodes).toBe(2);
  });

  it("enrollment stores an encrypted secret and returns a QR code + manual key", async () => {
    // No pending row exists, so the conditional update matches nothing and
    // the enrollment is created.
    mockDb.adminMfa.updateMany.mockResolvedValue({ count: 0 });
    mockDb.adminMfa.create.mockResolvedValue({ id: "mfa-1" });

    const enrollment = await startAdminMfaEnrollment({ userId: ADMIN_ID, email: ADMIN_EMAIL });
    expect(enrollment.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(enrollment.manualKey).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrollment.otpauthUrl).toContain("otpauth://totp/");
    expect(enrollment.otpauthUrl).toContain(encodeURIComponent(ADMIN_EMAIL));

    // The conditional update only touches a still-disabled enrollment.
    expect(mockDb.adminMfa.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: ADMIN_ID, enabledAt: null } })
    );
    const stored = mockDb.adminMfa.create.mock.calls[0][0].data;
    expect(stored.userId).toBe(ADMIN_ID);
    expect(stored.enabledAt).toBeNull();
    // The stored secret decrypts to the manual key.
    const key = Buffer.from(TEST_KEY, "base64");
    expect(decryptTotpSecret(stored.secretEncrypted, key)).toBe(enrollment.manualKey);
  });

  it("enrollment replaces a pending enrollment via the conditional update", async () => {
    mockDb.adminMfa.updateMany.mockResolvedValue({ count: 1 });

    const enrollment = await startAdminMfaEnrollment({ userId: ADMIN_ID, email: ADMIN_EMAIL });
    expect(enrollment.manualKey).toMatch(/^[A-Z2-7]{32}$/);
    expect(mockDb.adminMfa.create).not.toHaveBeenCalled();
    // No recovery codes are deleted: a pending enrollment cannot
    // legitimately have any, and deleting here could destroy codes issued
    // by a concurrent successful activation.
    expect(mockDb.adminMfaRecoveryCode.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.adminMfa.findUnique).not.toHaveBeenCalled();
  });

  it("enrollment fails closed without the encryption key", async () => {
    delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    await expect(startAdminMfaEnrollment({ userId: ADMIN_ID, email: ADMIN_EMAIL })).rejects.toThrow(
      "Administrator MFA is not configured."
    );
    expect(mockDb.adminMfa.updateMany).not.toHaveBeenCalled();
    expect(mockDb.adminMfa.create).not.toHaveBeenCalled();
  });

  it("activation enables MFA only after a valid first code, and returns recovery codes", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const step = totpTimeStep();
    const code = totpCodeForStep(secret, step);
    const storedSecret = encryptTotpSecret(secret, key);
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: storedSecret,
      pendingSecretEncrypted: null,
      enabledAt: null,
      lastUsedStep: 0,
    });
    mockTx.adminMfa.updateMany.mockResolvedValue({ count: 1 });
    mockTx.adminMfaRecoveryCode.createMany.mockResolvedValue({ count: 10 });

    const codes = await activateAdminMfa({ userId: ADMIN_ID, code });
    expect(codes).toHaveLength(10);
    for (const c of codes!) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // Enabling and issuing codes happened in one transaction.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    // The activation claimed the time step atomically, and only while the
    // same secret is still stored (stale-secret race guard).
    const updateCall = mockTx.adminMfa.updateMany.mock.calls[0][0];
    expect(updateCall.where.id).toBe("mfa-1");
    expect(updateCall.where.enabledAt).toBeNull();
    expect(updateCall.where.lastUsedStep).toEqual({ lt: step });
    expect(updateCall.where.secretEncrypted).toEqual(storedSecret);
    // Recovery codes were stored as hashes only.
    const created = mockTx.adminMfaRecoveryCode.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(10);
    for (const row of created) {
      expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(codes).not.toContain(row.codeHash);
    }
  });

  it("first-time activation rolls back when recovery-code creation fails", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const step = totpTimeStep();
    const code = totpCodeForStep(secret, step);
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: null,
      lastUsedStep: 0,
    });
    mockTx.adminMfa.updateMany.mockResolvedValue({ count: 1 });
    mockTx.adminMfaRecoveryCode.createMany.mockRejectedValue(new Error("database unavailable"));

    // The database failure aborts the activation (the transaction rolls
    // back), so MFA is never left enabled without its recovery codes.
    await expect(activateAdminMfa({ userId: ADMIN_ID, code })).rejects.toThrow("database unavailable");
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.adminMfa.updateMany).toHaveBeenCalledTimes(1);
  });

  it("activation rejects an invalid first code and does not enable MFA", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: null,
      lastUsedStep: 0,
    });

    const codes = await activateAdminMfa({ userId: ADMIN_ID, code: "000000" });
    expect(codes).toBeNull();
    // The code never verified, so no transaction was started.
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockTx.adminMfa.updateMany).not.toHaveBeenCalled();
    expect(mockTx.adminMfaRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it("activation rejects a replayed code (same time step as the last accepted one)", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const step = totpTimeStep();
    const code = totpCodeForStep(secret, step);
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: null,
      lastUsedStep: step, // this step was already used
    });

    const codes = await activateAdminMfa({ userId: ADMIN_ID, code });
    expect(codes).toBeNull();
    // The replay was rejected before any write, so no transaction started.
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockTx.adminMfa.updateMany).not.toHaveBeenCalled();
  });

  it("session verification accepts a valid TOTP code and records it", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const step = totpTimeStep();
    const code = totpCodeForStep(secret, step);
    const sessionIat = Math.floor(Date.now() / 1000) - 60; // session issued 1 minute ago
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
      lastVerifiedAt: null,
      lastUsedStep: 0,
      recoveryCodes: [],
    });
    mockDb.adminMfa.updateMany.mockResolvedValue({ count: 1 });

    const result = await verifyAdminMfaForSession({ userId: ADMIN_ID, code, sessionIat });
    expect(result).toBe("verified");
    expect(mockDb.adminMfa.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "mfa-1", lastUsedStep: { lt: step } } })
    );
  });

  it("session verification rejects a replayed TOTP code", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const step = totpTimeStep();
    const code = totpCodeForStep(secret, step);
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
      lastVerifiedAt: null,
      lastUsedStep: step, // already used
      recoveryCodes: [],
    });

    const result = await verifyAdminMfaForSession({
      userId: ADMIN_ID,
      code,
      sessionIat: Math.floor(Date.now() / 1000) - 60,
    });
    expect(result).toBe("invalid");
    expect(mockDb.adminMfa.updateMany).not.toHaveBeenCalled();
  });

  it("session verification accepts a recovery code once and consumes it", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const recoveryCode = "ABCDE-FGHIJ";
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
      lastVerifiedAt: null,
      lastUsedStep: 0,
      recoveryCodes: [{ id: "rc-1", codeHash: hashRecoveryCode(recoveryCode) }],
    });
    mockDb.adminMfaRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
    mockDb.adminMfa.update.mockResolvedValue({});

    const result = await verifyAdminMfaForSession({
      userId: ADMIN_ID,
      code: recoveryCode,
      sessionIat: Math.floor(Date.now() / 1000) - 60,
    });
    expect(result).toBe("verified");
    // The code was consumed atomically (guarded by usedAt null).
    expect(mockDb.adminMfaRecoveryCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rc-1", usedAt: null } })
    );
  });

  it("session verification rejects an unknown recovery code and does not consume anything", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
      lastVerifiedAt: null,
      lastUsedStep: 0,
      recoveryCodes: [{ id: "rc-1", codeHash: hashRecoveryCode("ABCDE-FGHIJ") }],
    });

    const result = await verifyAdminMfaForSession({
      userId: ADMIN_ID,
      code: "ZZZZZ-ZZZZZ",
      sessionIat: Math.floor(Date.now() / 1000) - 60,
    });
    expect(result).toBe("invalid");
    expect(mockDb.adminMfaRecoveryCode.updateMany).not.toHaveBeenCalled();
  });

  it("session verification returns not-enrolled when MFA is not enabled", async () => {
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: new Uint8Array(29),
      enabledAt: null,
      lastVerifiedAt: null,
      lastUsedStep: 0,
      recoveryCodes: [],
    });
    const result = await verifyAdminMfaForSession({
      userId: ADMIN_ID,
      code: "123456",
      sessionIat: Math.floor(Date.now() / 1000) - 60,
    });
    expect(result).toBe("not-enrolled");
  });

  it("regeneration deletes all previous codes and returns a fresh set", async () => {
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
    });
    mockTx.adminMfaRecoveryCode.deleteMany.mockResolvedValue({ count: 10 });
    mockTx.adminMfaRecoveryCode.createMany.mockResolvedValue({ count: 10 });

    const codes = await regenerateAdminMfaRecoveryCodes(ADMIN_ID);
    expect(codes).toHaveLength(10);
    // Deletion and creation are one transaction.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.adminMfaRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { mfaId: "mfa-1" } });
    const created = mockTx.adminMfaRecoveryCode.createMany.mock.calls[0][0].data;
    expect(new Set(created.map((r: { codeHash: string }) => r.codeHash)).size).toBe(10);
  });

  it("regeneration rolls back when recovery-code creation fails", async () => {
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
    });
    mockTx.adminMfaRecoveryCode.deleteMany.mockResolvedValue({ count: 10 });
    mockTx.adminMfaRecoveryCode.createMany.mockRejectedValue(new Error("database unavailable"));

    // The failure aborts the transaction, so the previous codes are not
    // deleted — MFA is not left without recovery codes.
    await expect(regenerateAdminMfaRecoveryCodes(ADMIN_ID)).rejects.toThrow("database unavailable");
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  it("regeneration returns null when MFA is not enabled", async () => {
    mockDb.adminMfa.findUnique.mockResolvedValue({ id: "mfa-1", enabledAt: null });
    expect(await regenerateAdminMfaRecoveryCodes(ADMIN_ID)).toBeNull();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockTx.adminMfaRecoveryCode.deleteMany).not.toHaveBeenCalled();
  });

  it("replacement activation rolls back when recovery-code creation fails", async () => {
    const key = Buffer.from(TEST_KEY, "base64");
    const oldSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const newSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const step = totpTimeStep();
    const code = totpCodeForStep(newSecret, step);
    const storedPending = encryptTotpSecret(newSecret, key);
    mockDb.adminMfa.findUnique.mockResolvedValue({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(oldSecret, key),
      pendingSecretEncrypted: storedPending,
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
      lastVerifiedAt: null,
      lastUsedStep: 0,
    });
    mockTx.adminMfa.updateMany.mockResolvedValue({ count: 1 });
    mockTx.adminMfaRecoveryCode.deleteMany.mockResolvedValue({ count: 10 });
    mockTx.adminMfaRecoveryCode.createMany.mockRejectedValue(new Error("database unavailable"));

    // The failure aborts the transaction, so the secret swap and the
    // deletion of the old codes roll back together: the old secret and
    // its recovery codes stay active.
    await expect(activateAdminMfa({ userId: ADMIN_ID, code })).rejects.toThrow("database unavailable");
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    // The swap was attempted only for the pending secret this activation
    // actually verified (pending-secret equality guard).
    const updateCall = mockTx.adminMfa.updateMany.mock.calls[0][0];
    expect(updateCall.where.pendingSecretEncrypted).toEqual(storedPending);
    expect(updateCall.data.secretEncrypted).toEqual(storedPending);
  });

  it("disablement requires the correct password and a valid code, then deletes MFA", async () => {
    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.hash("correct-password", 4);
    mockDb.user.findUnique.mockResolvedValue({ passwordHash });
    mockDb.adminMfa.findUnique.mockResolvedValueOnce({ id: "mfa-1", enabledAt: new Date() });
    // The verification step (called internally) needs the full MFA row.
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const step = totpTimeStep();
    const code = totpCodeForStep(secret, step);
    mockDb.adminMfa.findUnique.mockResolvedValueOnce({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
      lastVerifiedAt: null,
      lastUsedStep: 0,
      recoveryCodes: [],
    });
    mockDb.adminMfa.updateMany.mockResolvedValue({ count: 1 });
    mockDb.adminMfa.delete.mockResolvedValue({});

    const disabled = await disableAdminMfa({ userId: ADMIN_ID, password: "correct-password", code });
    expect(disabled).toBe(true);
    expect(mockDb.adminMfa.delete).toHaveBeenCalledWith({ where: { id: "mfa-1" } });
  });

  it("disablement rejects a wrong password and leaves MFA untouched", async () => {
    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.hash("correct-password", 4);
    mockDb.user.findUnique.mockResolvedValue({ passwordHash });

    const disabled = await disableAdminMfa({ userId: ADMIN_ID, password: "wrong-password", code: "123456" });
    expect(disabled).toBe(false);
    expect(mockDb.adminMfa.delete).not.toHaveBeenCalled();
  });

  it("disablement rejects a wrong code and leaves MFA untouched", async () => {
    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.hash("correct-password", 4);
    mockDb.user.findUnique.mockResolvedValue({ passwordHash });
    mockDb.adminMfa.findUnique.mockResolvedValueOnce({ id: "mfa-1", enabledAt: new Date() });
    const key = Buffer.from(TEST_KEY, "base64");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    mockDb.adminMfa.findUnique.mockResolvedValueOnce({
      id: "mfa-1",
      userId: ADMIN_ID,
      secretEncrypted: encryptTotpSecret(secret, key),
      pendingSecretEncrypted: null,
      enabledAt: new Date("2026-11-19T09:00:00.000Z"),
      lastVerifiedAt: null,
      lastUsedStep: 0,
      recoveryCodes: [],
    });

    const disabled = await disableAdminMfa({ userId: ADMIN_ID, password: "correct-password", code: "000000" });
    expect(disabled).toBe(false);
    expect(mockDb.adminMfa.delete).not.toHaveBeenCalled();
  });
});
