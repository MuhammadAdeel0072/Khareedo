// Administrator TOTP MFA (PR-10).
//
// TOTP secrets are encrypted at rest with AES-256-GCM. The key comes from
// ADMIN_MFA_ENCRYPTION_KEY (32 random bytes, base64 — generate with
// `openssl rand -base64 32`). If the key is missing or invalid, MFA
// enrollment and verification fail closed (MfaUnavailableError); nothing
// is ever stored or verified in plaintext. Rotating the key makes existing
// secrets undecryptable, so enrolled admins must re-enroll after a rotation
// (see docs/ADMIN-MFA.md).
//
// Recovery codes are single-use: only the SHA-256 hash is stored, the raw
// code is shown to the admin once at generation and never persisted or
// logged. Redemption sets usedAt atomically (guarded by usedAt null), and
// regeneration deletes all previous codes.
//
// Replay protection: a TOTP code is accepted only for a time step strictly
// greater than the last accepted step (lastUsedStep). The accepted step is
// recorded in the same transaction as the verification, so a code cannot be
// replayed within its 30-second window — even concurrently, because the
// update is guarded by lastUsedStep < step.
//
// Session binding: a successful verification sets lastVerifiedAt. The auth
// guard requires lastVerifiedAt to be after the session's issued-at time
// (session.iat), so each new login must verify MFA again — the same pattern
// as PR-09's passwordChangedAt. A stolen session cookie from before MFA
// was verified cannot be used to reach the admin panel.
import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { generateTotpSecret, totpAuthUrl, verifyTotpCode } from "@/lib/totp";

export const MFA_ISSUER = "Khareedo";
export const MFA_RECOVERY_CODE_COUNT = 10;
export const MFA_TOTP_STEP_WINDOW = 1; // re-exported for callers that log it

export class MfaUnavailableError extends Error {
  constructor(message = "Administrator MFA is not configured.") {
    super(message);
    this.name = "MfaUnavailableError";
  }
}

export class MfaNotEnrolledError extends Error {
  constructor(message = "Administrator MFA is not set up.") {
    super(message);
    this.name = "MfaNotEnrolledError";
  }
}

/** Load the MFA encryption key (32 bytes, base64) or null when unconfigured. */
export function loadAdminMfaEncryptionKey(
  env: Readonly<Record<string, string | undefined>> = process.env
): Buffer | null {
  const raw = env.ADMIN_MFA_ENCRYPTION_KEY;
  if (!raw || raw.length === 0 || raw.length > 4096 || /[^\x21-\x7e]/.test(raw)) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  if (key.byteLength !== 32) return null;
  return key;
}

function requireMfaKey(): Buffer {
  const key = loadAdminMfaEncryptionKey();
  if (!key) throw new MfaUnavailableError();
  return key;
}

/** Encrypt a TOTP secret. Layout: IV (12 bytes) || auth tag (16 bytes) || ciphertext. */
export function encryptTotpSecret(secret: string, key: Buffer): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const combined = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  // Copy into a fresh Uint8Array (backed by a plain ArrayBuffer) so the
  // result matches Prisma's Bytes field type exactly.
  const out = new Uint8Array(combined.byteLength);
  out.set(combined);
  return out;
}

/** Decrypt a TOTP secret produced by encryptTotpSecret. Throws on tampering. */
export function decryptTotpSecret(encrypted: Uint8Array, key: Buffer): string {
  const bytes = Buffer.from(encrypted);
  if (bytes.byteLength < 12 + 16 + 1) throw new Error("Invalid encrypted MFA secret.");
  const iv = bytes.subarray(0, 12);
  const authTag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += RECOVERY_CODE_ALPHABET[bytes[i] % RECOVERY_CODE_ALPHABET.length];
    if (i === 4) code += "-";
  }
  return code;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

async function createRecoveryCodes(mfaId: string, count = MFA_RECOVERY_CODE_COUNT): Promise<string[]> {
  const codes = Array.from({ length: count }, () => generateRecoveryCode());
  await db.adminMfaRecoveryCode.createMany({
    data: codes.map((code) => ({ mfaId, codeHash: hashRecoveryCode(code) })),
  });
  return codes;
}

export type AdminMfaStatus = {
  enrolled: boolean;
  enabled: boolean;
  enabledAt: Date | null;
  hasRecoveryCodes: boolean;
  unusedRecoveryCodes: number;
};

/** MFA status for an admin (never includes the secret or raw codes). */
export async function getAdminMfaStatus(userId: string): Promise<AdminMfaStatus> {
  const mfa = await db.adminMfa.findUnique({
    where: { userId },
    select: { enabledAt: true, recoveryCodes: { select: { usedAt: true } } },
  });
  if (!mfa) {
    return { enrolled: false, enabled: false, enabledAt: null, hasRecoveryCodes: false, unusedRecoveryCodes: 0 };
  }
  const unused = mfa.recoveryCodes.filter((c) => c.usedAt === null).length;
  return {
    enrolled: true,
    enabled: mfa.enabledAt !== null,
    enabledAt: mfa.enabledAt,
    hasRecoveryCodes: mfa.recoveryCodes.length > 0,
    unusedRecoveryCodes: unused,
  };
}

/**
 * Start (or restart) MFA enrollment. Generates a fresh secret, encrypts and
 * stores it (replacing any pending enrollment), and returns the QR code data
 * URL plus the manual setup key. MFA is NOT enabled until the admin verifies
 * a first code via activateAdminMfa. Throws MfaUnavailableError when the
 * encryption key is not configured.
 */
export async function startAdminMfaEnrollment(input: { userId: string; email: string }): Promise<{
  qrCodeDataUrl: string;
  manualKey: string;
  otpauthUrl: string;
}> {
  const key = requireMfaKey();
  const secret = generateTotpSecret();
  const otpauthUrl = totpAuthUrl({ issuer: MFA_ISSUER, account: input.email, secret });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 2 });
  await db.adminMfa.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      secretEncrypted: encryptTotpSecret(secret, key),
      enabledAt: null,
      lastVerifiedAt: null,
      lastUsedStep: 0,
    },
    update: {
      secretEncrypted: encryptTotpSecret(secret, key),
      enabledAt: null,
      lastVerifiedAt: null,
      lastUsedStep: 0,
    },
  });
  // Re-enrollment discards any previous recovery codes: they belonged to the
  // old secret and must not survive a secret change.
  const mfa = await db.adminMfa.findUnique({ where: { userId: input.userId }, select: { id: true } });
  if (mfa) await db.adminMfaRecoveryCode.deleteMany({ where: { mfaId: mfa.id } });
  return { qrCodeDataUrl, manualKey: secret, otpauthUrl };
}

/**
 * Activate MFA after enrollment: verify the first TOTP code, mark MFA
 * enabled, and generate the recovery codes (returned once, never stored).
 * Returns null when the code is invalid, expired, or a replay.
 */
export async function activateAdminMfa(input: { userId: string; code: string }): Promise<string[] | null> {
  const key = requireMfaKey();
  const mfa = await db.adminMfa.findUnique({ where: { userId: input.userId } });
  if (!mfa) return null;
  let secret: string;
  try {
    secret = decryptTotpSecret(mfa.secretEncrypted, key);
  } catch {
    return null;
  }
  const step = verifyTotpCode(secret, input.code);
  if (step === null || step <= mfa.lastUsedStep) return null;
  const now = new Date();
  const claimed = await db.adminMfa.updateMany({
    where: { id: mfa.id, lastUsedStep: { lt: step } },
    data: { enabledAt: now, lastVerifiedAt: now, lastUsedStep: step },
  });
  if (claimed.count !== 1) return null;
  // Activation issues a fresh set of recovery codes.
  await db.adminMfaRecoveryCode.deleteMany({ where: { mfaId: mfa.id } });
  return createRecoveryCodes(mfa.id);
}

export type MfaVerificationResult = "verified" | "invalid" | "not-enrolled" | "unavailable";

/**
 * Verify a TOTP code (or a recovery code) for the current session. On
 * success, records lastVerifiedAt so the auth guard accepts this session.
 * A recovery code is single-use: it is consumed atomically and cannot be
 * used again. Returns "verified" only when the session is now MFA-verified.
 */
export async function verifyAdminMfaForSession(input: {
  userId: string;
  code: string;
  sessionIat: number | undefined;
}): Promise<MfaVerificationResult> {
  const key = loadAdminMfaEncryptionKey();
  if (!key) return "unavailable";
  const mfa = await db.adminMfa.findUnique({
    where: { userId: input.userId },
    include: { recoveryCodes: { where: { usedAt: null }, select: { id: true, codeHash: true } } },
  });
  if (!mfa || !mfa.enabledAt) return "not-enrolled";
  // Already verified for this session: do not consume another code.
  if (isMfaVerifiedForSession(mfa.lastVerifiedAt, input.sessionIat)) return "verified";

  const clean = input.code.trim();
  // Recovery codes are tried first: they are 11 chars (10 + hyphen), while
  // TOTP codes are exactly 6 digits.
  if (clean.length === 11) {
    const codeHash = hashRecoveryCode(clean);
    const match = mfa.recoveryCodes.find((c) => c.codeHash === codeHash);
    if (match) {
      const consumed = await db.adminMfaRecoveryCode.updateMany({
        where: { id: match.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count === 1) {
        await db.adminMfa.update({
          where: { id: mfa.id },
          data: { lastVerifiedAt: new Date() },
        });
        return "verified";
      }
    }
    return "invalid";
  }

  let secret: string;
  try {
    secret = decryptTotpSecret(mfa.secretEncrypted, key);
  } catch {
    return "invalid";
  }
  const step = verifyTotpCode(secret, clean);
  if (step === null || step <= mfa.lastUsedStep) return "invalid";
  const claimed = await db.adminMfa.updateMany({
    where: { id: mfa.id, lastUsedStep: { lt: step } },
    data: { lastVerifiedAt: new Date(), lastUsedStep: step },
  });
  return claimed.count === 1 ? "verified" : "invalid";
}

/** Pure helper: is MFA verified for a session issued at `iat` (seconds)? */
export function isMfaVerifiedForSession(
  lastVerifiedAt: Date | null,
  iat: number | undefined
): boolean {
  if (!lastVerifiedAt || typeof iat !== "number") return false;
  return lastVerifiedAt.getTime() > iat * 1000;
}

/**
 * Regenerate recovery codes: deletes all previous codes (used and unused)
 * and returns a fresh set (once, never stored). Requires MFA to be enabled.
 * Returns null when MFA is not enabled.
 */
export async function regenerateAdminMfaRecoveryCodes(userId: string): Promise<string[] | null> {
  const mfa = await db.adminMfa.findUnique({ where: { userId }, select: { id: true, enabledAt: true } });
  if (!mfa || !mfa.enabledAt) return null;
  await db.adminMfaRecoveryCode.deleteMany({ where: { mfaId: mfa.id } });
  return createRecoveryCodes(mfa.id);
}

/**
 * Disable MFA. Requires the admin's current password (reauthentication) and
 * a valid TOTP code or recovery code. Deletes the secret and all recovery
 * codes. Returns false when the password or code is wrong, or MFA is not
 * enabled.
 */
export async function disableAdminMfa(input: {
  userId: string;
  password: string;
  code: string;
}): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: input.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) return false;
  const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordValid) return false;
  const mfa = await db.adminMfa.findUnique({ where: { userId: input.userId }, select: { id: true, enabledAt: true } });
  if (!mfa || !mfa.enabledAt) return false;
  // The code must be valid before anything is deleted: verify it through
  // the session path (which consumes a recovery code or records the step),
  // then delete. A failed verification leaves MFA untouched.
  const verification = await verifyAdminMfaForSession({
    userId: input.userId,
    code: input.code,
    sessionIat: undefined,
  });
  if (verification !== "verified") return false;
  await db.adminMfa.delete({ where: { id: mfa.id } });
  return true;
}
