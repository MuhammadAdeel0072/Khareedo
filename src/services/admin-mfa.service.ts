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
// Session binding (Phase 2, area B — M-4): a successful verification sets
// lastVerifiedAt AND lastVerifiedSessionId (the current session's `sid`
// claim, minted once at sign-in). The auth guard requires lastVerifiedAt
// to be after the session's issued-at time AND lastVerifiedSessionId to
// equal the session's `sid`, so each new login must verify MFA again —
// the same pattern as PR-09's passwordChangedAt — and a verification
// performed in one session cannot authorize a different session. A stolen
// session cookie from before MFA was verified cannot be used to reach the
// admin panel, and neither can a session stolen after the victim verified
// in their own session. (An earlier version of this comment claimed the
// timestamp check alone provided that protection; it did not — the binding
// is what provides it.) Sessions issued before the `sid` change carry no
// sid; the guard fails closed for them and the admin re-verifies once
// after signing in again.
import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { generateTotpSecret, totpAuthUrl, verifyTotpCode } from "@/lib/totp";
import {
  ADMIN_AUDIT_ACTIONS,
  recordAdminAudit,
  recordAdminAuditBestEffort,
  type AdminAuditContext,
} from "@/services/admin-audit.service";

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

export class MfaAlreadyEnabledError extends Error {
  constructor(
    message = "Administrator MFA is already enabled. Use the replacement flow to change authenticators."
  ) {
    super(message);
    this.name = "MfaAlreadyEnabledError";
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

/** Minimal store shape for recovery-code creation. Both the base client
 * (`db`) and a transaction client (`tx`) satisfy it, so code creation can
 * run inside a transaction and roll back with it. */
type RecoveryCodeStore = {
  adminMfaRecoveryCode: {
    createMany: (args: {
      data: { mfaId: string; codeHash: string }[];
    }) => Promise<{ count: number }>;
  };
};

async function createRecoveryCodes(
  mfaId: string,
  store: RecoveryCodeStore = db,
  count = MFA_RECOVERY_CODE_COUNT
): Promise<string[]> {
  const codes = Array.from({ length: count }, () => generateRecoveryCode());
  await store.adminMfaRecoveryCode.createMany({
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

/** True when a Prisma error is a unique-constraint violation (P2002). */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Start (or restart) FIRST-TIME MFA enrollment. Generates a fresh secret,
 * encrypts and stores it (replacing any pending enrollment), and returns
 * the QR code data URL plus the manual setup key. MFA is NOT enabled until
 * the admin verifies a first code via activateAdminMfa. Throws
 * MfaAlreadyEnabledError when MFA is already active: the initial setup
 * endpoint must NEVER replace an active enrollment (P1 fix) — a
 * password-only session must not be able to take over MFA. Active
 * enrollment changes go through startAdminMfaReplacement, which requires
 * the current password and a valid current code. Throws
 * MfaUnavailableError when the encryption key is not configured.
 *
 * TOCTOU-safe: the write is conditional on MFA still being disabled.
 * The secret and QR code are generated first (outside any write); the
 * database write then uses updateMany guarded on `enabledAt: null`, so a
 * concurrent activation that enabled MFA between the check and the write
 * cannot be overwritten — the update matches zero rows and the enrollment
 * is refused. A fresh row is created only when no row exists.
 *
 * No recovery codes are deleted here: a pending (never-enabled) enrollment
 * cannot legitimately have recovery codes — codes are only created at
 * activation, which sets enabledAt. Deleting codes from this path could
 * destroy codes issued by a concurrent successful activation.
 */
export async function startAdminMfaEnrollment(input: {
  userId: string;
  email: string;
  audit?: AdminAuditContext;
}): Promise<{
  qrCodeDataUrl: string;
  manualKey: string;
  otpauthUrl: string;
}> {
  const key = requireMfaKey();
  const secret = generateTotpSecret();
  const otpauthUrl = totpAuthUrl({ issuer: MFA_ISSUER, account: input.email, secret });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 2 });
  const encrypted = encryptTotpSecret(secret, key);
  // Replace a still-disabled (pending) enrollment. The enabledAt guard is
  // the race protection: if a concurrent activation enabled MFA after the
  // pre-check, this matches zero rows and the enrollment is refused.
  const replaced = await db.adminMfa.updateMany({
    where: { userId: input.userId, enabledAt: null },
    data: {
      secretEncrypted: encrypted,
      pendingSecretEncrypted: null,
      lastVerifiedAt: null,
      lastUsedStep: 0,
    },
  });
  if (replaced.count === 1) {
    if (input.audit) {
      await recordAdminAuditBestEffort(input.audit, {
        action: ADMIN_AUDIT_ACTIONS.MFA_ENROLLMENT_STARTED,
        targetType: "AdminMfa",
        targetId: input.userId,
      });
    }
    return { qrCodeDataUrl, manualKey: secret, otpauthUrl };
  }
  // No pending row was replaced: either no row exists (first enrollment)
  // or MFA is now active (a concurrent activation won the race).
  try {
    await db.adminMfa.create({
      data: {
        userId: input.userId,
        secretEncrypted: encrypted,
        pendingSecretEncrypted: null,
        enabledAt: null,
        lastVerifiedAt: null,
        lastUsedStep: 0,
      },
    });
    if (input.audit) {
      await recordAdminAuditBestEffort(input.audit, {
        action: ADMIN_AUDIT_ACTIONS.MFA_ENROLLMENT_STARTED,
        targetType: "AdminMfa",
        targetId: input.userId,
      });
    }
    return { qrCodeDataUrl, manualKey: secret, otpauthUrl };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // A row appeared concurrently. Re-check: if MFA is now active, refuse;
    // if a concurrent enrollment created a pending row, our secret was not
    // stored, so refuse and let the caller retry against that enrollment.
    const existing = await db.adminMfa.findUnique({
      where: { userId: input.userId },
      select: { enabledAt: true },
    });
    if (existing?.enabledAt) throw new MfaAlreadyEnabledError();
    throw new Error("Another MFA enrollment started at the same time. Please try again.");
  }
}

/**
 * Verify a TOTP code or recovery code against the ACTIVE MFA secret, for
 * reauthentication flows (replacement enrollment). This is a fresh check:
 * it does not short-circuit on an already-verified session, and it does
 * not set lastVerifiedAt. A TOTP code is checked only (lastUsedStep is
 * not advanced — the step counter belongs to the secret being replaced,
 * and advancing it would reject the replacement activation code from the
 * same 30-second window). A recovery code is single-use and is consumed
 * on success. Returns false when MFA is not active or the code is wrong.
 */
export async function verifyActiveMfaCode(input: { userId: string; code: string }): Promise<boolean> {
  const key = loadAdminMfaEncryptionKey();
  if (!key) return false;
  const mfa = await db.adminMfa.findUnique({
    where: { userId: input.userId },
    include: { recoveryCodes: { where: { usedAt: null }, select: { id: true, codeHash: true } } },
  });
  if (!mfa || !mfa.enabledAt) return false;
  const clean = input.code.trim();
  if (clean.length === 11) {
    const codeHash = hashRecoveryCode(clean);
    const match = mfa.recoveryCodes.find((c) => c.codeHash === codeHash);
    if (!match) return false;
    const consumed = await db.adminMfaRecoveryCode.updateMany({
      where: { id: match.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return consumed.count === 1;
  }
  let secret: string;
  try {
    secret = decryptTotpSecret(mfa.secretEncrypted, key);
  } catch {
    return false;
  }
  const step = verifyTotpCode(secret, clean);
  if (step === null || step <= mfa.lastUsedStep) return false;
  return true;
}

/**
 * Start a REPLACEMENT enrollment for an already-active MFA. Requires the
 * admin's current password AND a valid current TOTP code or recovery code
 * (fresh reauthentication). On success, generates a new secret and stores
 * it as a PENDING replacement (pendingSecretEncrypted); the ACTIVE secret,
 * enabledAt, lastVerifiedAt, and recovery codes are all preserved, so a
 * failed or abandoned replacement never disables MFA or invalidates the
 * active secret or codes. The replacement is completed by verifying a code
 * from the new secret via activateAdminMfa, which atomically swaps it in.
 * Returns null when MFA is not active, the password is wrong, or the
 * current code is invalid. Throws MfaUnavailableError when the encryption
 * key is not configured.
 */
export async function startAdminMfaReplacement(input: {
  userId: string;
  email: string;
  password: string;
  code: string;
  audit?: AdminAuditContext;
}): Promise<{ qrCodeDataUrl: string; manualKey: string; otpauthUrl: string } | null> {
  const key = requireMfaKey();
  const mfa = await db.adminMfa.findUnique({
    where: { userId: input.userId },
    select: { id: true, enabledAt: true },
  });
  if (!mfa || !mfa.enabledAt) return null;
  const user = await db.user.findUnique({ where: { id: input.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) return null;
  const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordValid) return null;
  const codeValid = await verifyActiveMfaCode({ userId: input.userId, code: input.code });
  if (!codeValid) return null;
  const secret = generateTotpSecret();
  const otpauthUrl = totpAuthUrl({ issuer: MFA_ISSUER, account: input.email, secret });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 2 });
  await db.adminMfa.update({
    where: { id: mfa.id },
    data: { pendingSecretEncrypted: encryptTotpSecret(secret, key) },
  });
  if (input.audit) {
    await recordAdminAuditBestEffort(input.audit, {
      action: ADMIN_AUDIT_ACTIONS.MFA_REPLACEMENT_STARTED,
      targetType: "AdminMfa",
      targetId: input.userId,
    });
  }
  return { qrCodeDataUrl, manualKey: secret, otpauthUrl };
}

/**
 * Activate MFA after enrollment: verify a TOTP code against the pending
 * secret, mark MFA enabled, and generate the recovery codes (returned once,
 * never stored). Returns null when the code is invalid, expired, or a
 * replay. A database failure while issuing codes aborts the whole
 * activation (the transaction rolls back), so MFA is never left enabled
 * without its recovery codes.
 *
 * Two cases (P1 fix):
 * - First-time enrollment: no pending replacement and enabledAt is null.
 *   The code is verified against secretEncrypted; success sets enabledAt.
 *   Enabling and issuing the recovery-code hashes happen in one
 *   transaction: they succeed or fail together. No old codes are deleted
 *   here — a pending enrollment has none.
 * - Replacement enrollment: pendingSecretEncrypted is set (started via
 *   startAdminMfaReplacement after password + current-code reauthentication).
 *   The code is verified against the PENDING secret; success atomically
 *   swaps it into secretEncrypted, keeps enabledAt (MFA stays enabled),
 *   invalidates the old recovery codes, and issues fresh ones — all in
 *   one transaction, so a failed code creation rolls back the swap too.
 *   The active secret is never touched until the replacement code
 *   verifies, so a failed or abandoned replacement leaves the active MFA
 *   fully intact.
 * - MFA already active with no pending replacement: returns null. This
 *   closes a bypass where activate could otherwise regenerate recovery
 *   codes on an active enrollment without the requireAdminMfaVerified
 *   gate of the recovery-codes endpoint.
 */
export async function activateAdminMfa(input: {
  userId: string;
  code: string;
  audit?: AdminAuditContext;
  // Session the activation is performed in (Phase 2, area B). Stored as
  // lastVerifiedSessionId so the activating session is MFA-verified
  // immediately. Undefined for sessions issued before the `sid` change:
  // activation still succeeds (MFA is enabled, which is the security
  // property), but the session is not bound — the guard fails closed and
  // the admin re-verifies after their next sign-in.
  sessionSid: string | undefined;
}): Promise<string[] | null> {
  const key = requireMfaKey();
  const mfa = await db.adminMfa.findUnique({ where: { userId: input.userId } });
  if (!mfa) return null;
  const isReplacement = mfa.pendingSecretEncrypted !== null;
  if (!isReplacement && mfa.enabledAt) return null;
  const pendingBytes = isReplacement ? mfa.pendingSecretEncrypted : mfa.secretEncrypted;
  if (pendingBytes === null) return null;
  let secret: string;
  try {
    secret = decryptTotpSecret(pendingBytes, key);
  } catch {
    return null;
  }
  const step = verifyTotpCode(secret, input.code);
  if (step === null) return null;
  // Replay check applies only to first-time activation: lastUsedStep
  // belongs to the secret being replaced, so comparing a new secret's step
  // against it would wrongly reject a valid code from the same 30-second
  // window. The replacement swap resets the counter to this step instead.
  if (!isReplacement && step <= mfa.lastUsedStep) return null;
  const now = new Date();
  if (isReplacement) {
    // Atomic swap + rotation: the new secret becomes active, the pending
    // slot is cleared, MFA stays enabled, the old recovery codes are
    // deleted, and fresh ones are issued — all in one transaction. The
    // pendingSecretEncrypted guard makes the swap single-flight: the
    // first activation clears the slot, so a concurrent one matches
    // nothing. The equality check on the pending bytes also guards
    // against a concurrent replacement start overwriting the pending
    // secret after this activation read it: the swap only happens for the
    // secret this activation actually verified. If code creation fails,
    // the whole transaction rolls back and the old secret and codes stay.
    return db.$transaction(async (tx) => {
      const claimed = await tx.adminMfa.updateMany({
        where: { id: mfa.id, pendingSecretEncrypted: pendingBytes },
        data: {
          secretEncrypted: pendingBytes,
          pendingSecretEncrypted: null,
          lastVerifiedAt: now,
          lastVerifiedSessionId: input.sessionSid ?? null,
          lastUsedStep: step,
        },
      });
      if (claimed.count !== 1) return null;
      await tx.adminMfaRecoveryCode.deleteMany({ where: { mfaId: mfa.id } });
      const codes = await createRecoveryCodes(mfa.id, tx);
      if (input.audit) {
        await recordAdminAudit(
          input.audit,
          {
            action: ADMIN_AUDIT_ACTIONS.MFA_REPLACEMENT_ACTIVATED,
            targetType: "AdminMfa",
            targetId: input.userId,
          },
          tx
        );
      }
      return codes;
    });
  }
  // First-time activation. The secret-equality guard is the race
  // protection: the activation verified a code against the secret it read,
  // so the update only succeeds while that same secret is still stored. A
  // concurrent enrollment that replaced the secret after the read matches
  // zero rows, so activation cannot enable MFA with a secret the admin
  // never set up (which would lock them out). enabledAt: null guards
  // against a concurrent activation having already enabled MFA. Enabling
  // and issuing the recovery codes are one transaction: if code creation
  // fails, the enablement rolls back and MFA stays disabled.
  return db.$transaction(async (tx) => {
    const claimed = await tx.adminMfa.updateMany({
      where: { id: mfa.id, secretEncrypted: pendingBytes, enabledAt: null, lastUsedStep: { lt: step } },
      data: { enabledAt: now, lastVerifiedAt: now, lastVerifiedSessionId: input.sessionSid ?? null, lastUsedStep: step },
    });
    if (claimed.count !== 1) return null;
    const codes = await createRecoveryCodes(mfa.id, tx);
    if (input.audit) {
      await recordAdminAudit(
        input.audit,
        {
          action: ADMIN_AUDIT_ACTIONS.MFA_ACTIVATED,
          targetType: "AdminMfa",
          targetId: input.userId,
        },
        tx
      );
    }
    return codes;
  });
}

export type MfaVerificationResult = "verified" | "invalid" | "not-enrolled" | "unavailable";

/**
 * Verify a TOTP code (or a recovery code) for the current session. On
 * success, records lastVerifiedAt AND lastVerifiedSessionId so the auth
 * guard accepts this session (and only this session). A recovery code is
 * single-use: it is consumed atomically and cannot be used again. Returns
 * "verified" only when the session is now MFA-verified. When the session
 * carries no `sid` (issued before the sid change), verification cannot be
 * bound to a session and returns "invalid" — the admin must sign out and
 * sign in again, which mints a sid. The verify route turns that case into
 * a clear message instead of a wrong-code error.
 */
/**
 * Validate a TOTP code or a recovery code against the stored MFA state and
 * consume it: a matching recovery code is marked used atomically, and a
 * valid TOTP code advances lastUsedStep (guarded, so the same code cannot
 * be accepted twice). Does NOT record a verification — callers decide what
 * a valid code means. Used by the session-verification path (which then
 * records lastVerifiedAt + lastVerifiedSessionId) and by disablement
 * (which only needs a fresh proof of possession before deleting the
 * enrollment, and must check the code even when the session is already
 * verified — so it cannot go through the session path's short-circuit).
 */
async function consumeValidAdminMfaCode(
  mfa: {
    id: string;
    secretEncrypted: Uint8Array;
    lastUsedStep: number;
    recoveryCodes: { id: string; codeHash: string }[];
  },
  code: string,
  key: Buffer
): Promise<boolean> {
  const clean = code.trim();
  // Recovery codes are tried first: they are 11 chars (10 + hyphen), while
  // TOTP codes are exactly 6 digits.
  if (clean.length === 11) {
    const codeHash = hashRecoveryCode(clean);
    const match = mfa.recoveryCodes.find((c) => c.codeHash === codeHash);
    if (!match) return false;
    const consumed = await db.adminMfaRecoveryCode.updateMany({
      where: { id: match.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return consumed.count === 1;
  }

  let secret: string;
  try {
    secret = decryptTotpSecret(mfa.secretEncrypted, key);
  } catch {
    return false;
  }
  const step = verifyTotpCode(secret, clean);
  if (step === null || step <= mfa.lastUsedStep) return false;
  const claimed = await db.adminMfa.updateMany({
    where: { id: mfa.id, lastUsedStep: { lt: step } },
    data: { lastUsedStep: step },
  });
  return claimed.count === 1;
}

export async function verifyAdminMfaForSession(input: {
  userId: string;
  code: string;
  sessionIat: number | undefined;
  sessionSid: string | undefined;
}): Promise<MfaVerificationResult> {
  const key = loadAdminMfaEncryptionKey();
  if (!key) return "unavailable";
  const mfa = await db.adminMfa.findUnique({
    where: { userId: input.userId },
    include: { recoveryCodes: { where: { usedAt: null }, select: { id: true, codeHash: true } } },
  });
  if (!mfa || !mfa.enabledAt) return "not-enrolled";
  // Already verified for this session: do not consume another code.
  if (
    isMfaVerifiedForSession(
      mfa.lastVerifiedAt,
      input.sessionIat,
      mfa.lastVerifiedSessionId,
      input.sessionSid
    )
  ) {
    return "verified";
  }
  // No session id to bind to (pre-sid token): fail closed. Binding the
  // verification to "no session" would let the guard accept any session,
  // which is exactly the hole the binding closes.
  if (!input.sessionSid) return "invalid";

  const valid = await consumeValidAdminMfaCode(mfa, input.code, key);
  if (!valid) return "invalid";
  await db.adminMfa.update({
    where: { id: mfa.id },
    data: { lastVerifiedAt: new Date(), lastVerifiedSessionId: input.sessionSid },
  });
  return "verified";
}

/**
 * Pure helper: is MFA verified for a session issued at `iat` (seconds)?
 * Mirrors the guard's copy in src/lib/auth-guard.ts — keep the two in
 * sync. Requires the verification timestamp to be after the session's
 * issued-at time AND the verification to be bound to this exact session
 * (lastVerifiedSessionId === sessionSid). Fails closed when any value is
 * missing.
 */
export function isMfaVerifiedForSession(
  lastVerifiedAt: Date | null,
  iat: number | undefined,
  lastVerifiedSessionId: string | null | undefined,
  sessionSid: string | undefined
): boolean {
  if (!lastVerifiedAt || typeof iat !== "number") return false;
  if (lastVerifiedAt.getTime() <= iat * 1000) return false;
  if (!lastVerifiedSessionId || !sessionSid) return false;
  return lastVerifiedSessionId === sessionSid;
}

/**
 * Regenerate recovery codes: deletes all previous codes (used and unused)
 * and returns a fresh set (once, never stored). Requires MFA to be enabled.
 * Returns null when MFA is not enabled. Deletion and creation are one
 * transaction, so a failed creation leaves the previous codes intact
 * instead of leaving MFA enabled with no recovery codes.
 */
export async function regenerateAdminMfaRecoveryCodes(
  userId: string,
  audit?: AdminAuditContext
): Promise<string[] | null> {
  const mfa = await db.adminMfa.findUnique({ where: { userId }, select: { id: true, enabledAt: true } });
  if (!mfa || !mfa.enabledAt) return null;
  return db.$transaction(async (tx) => {
    await tx.adminMfaRecoveryCode.deleteMany({ where: { mfaId: mfa.id } });
    const codes = await createRecoveryCodes(mfa.id, tx);
    if (audit) {
      await recordAdminAudit(
        audit,
        {
          action: ADMIN_AUDIT_ACTIONS.MFA_RECOVERY_CODES_REGENERATED,
          targetType: "AdminMfa",
          targetId: userId,
        },
        tx
      );
    }
    return codes;
  });
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
  audit?: AdminAuditContext;
}): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: input.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) return false;
  const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordValid) return false;
  const mfa = await db.adminMfa.findUnique({
    where: { userId: input.userId },
    include: { recoveryCodes: { where: { usedAt: null }, select: { id: true, codeHash: true } } },
  });
  if (!mfa || !mfa.enabledAt) return false;
  // The code must be valid before anything is deleted. It is checked as a
  // fresh proof of possession (consumeValidAdminMfaCode), NOT through the
  // session-verification path: the session is already verified here, so
  // that path's short-circuit would accept without checking the code at
  // all — and disablement must always re-authenticate with a code.
  const key = loadAdminMfaEncryptionKey();
  if (!key) return false;
  const codeValid = await consumeValidAdminMfaCode(mfa, input.code, key);
  if (!codeValid) return false;
  await db.adminMfa.delete({ where: { id: mfa.id } });
  if (input.audit) {
    await recordAdminAuditBestEffort(input.audit, {
      action: ADMIN_AUDIT_ACTIONS.MFA_DISABLED,
      targetType: "AdminMfa",
      targetId: input.userId,
    });
  }
  return true;
}
