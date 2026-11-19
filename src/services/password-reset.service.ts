// Password reset (PR-09). Mirrors the email-verification token pattern:
// cryptographically secure random token, only its SHA-256 hash stored,
// single-use (consumedAt) and expiring. The raw token is emailed once and
// never persisted or logged.
//
// Enumeration safety (PR-09 security-review fix): the forgot-password
// endpoint must be indistinguishable for registered, unregistered, and
// OAuth-only addresses. The token is therefore NOT created here and the
// email is NOT sent here. requestPasswordReset enqueues exactly one outbox
// row — the same single DB write for every address — and returns. A
// background worker (src/services/email-outbox.service.ts) generates the
// token at delivery time, stores only its hash, and sends the email. SMTP
// failures happen in the background, are retried with backoff, and never
// reach the HTTP response. Identical response text alone was not enough:
// the synchronous send leaked account existence through timing (a registered
// account did a DB write plus an SMTP round-trip; an unknown address
// returned in milliseconds) and through SMTP failure responses (503 for a
// registered account versus 200 for an unknown one).
//
// Session invalidation: a successful reset sets passwordChangedAt, and the
// auth guard invalidates JWT sessions issued at or before that timestamp,
// because NextAuth v4 JWTs are not revocable. This is the design choice the
// Phase 0 report requires to be stated explicitly.
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { findUserByEmail } from "@/services/auth-users.service";
import { passwordSchema } from "@/lib/validation";
import { enqueuePasswordResetEmail } from "@/services/email-outbox.service";

export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export function hashPasswordResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function isPasswordResetTokenUsable(
  token: { expiresAt: Date; consumedAt: Date | null },
  now = new Date()
) {
  return token.consumedAt === null && token.expiresAt.getTime() > now.getTime();
}

/**
 * Request a password reset. Enumeration-safe: always enqueues exactly one
 * outbox row and resolves (void) with the same observable outcome whether
 * or not an eligible account exists. Only credentials accounts
 * (passwordHash set) carry a userId in the row; unknown emails and
 * OAuth-only accounts enqueue a no-op row (userId null) that the worker
 * discards without sending anything. No token is created here and no email
 * is sent here — the worker does both at delivery time.
 */
export async function requestPasswordReset(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normalizedEmail);
  await enqueuePasswordResetEmail({
    userId: user && user.passwordHash ? user.id : null,
    email: normalizedEmail,
    name: user?.name ?? null,
  });
}

class InvalidResetStateError extends Error {}

/**
 * Redeem a reset token and set a new password. Returns the user on success,
 * or null when the token is missing, invalid, expired, or already used.
 * The token is consumed atomically (consumedAt set only when still unused
 * and unexpired) and the password change is recorded with
 * passwordChangedAt in the same transaction, so a reset can never leave a
 * usable token behind or a stale session valid.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string
) {
  if (!token || token.length > 256) return null;
  const password = passwordSchema.safeParse(newPassword);
  if (!password.success) return null;

  const tokenHash = hashPasswordResetToken(token);
  const now = new Date();

  try {
    return await db.$transaction(async (transaction) => {
      const record = await transaction.passwordResetToken.findUnique({
        where: { tokenHash },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              passwordHash: true,
              name: true,
              role: true,
            },
          },
        },
      });
      if (
        !record ||
        !record.user.passwordHash ||
        !isPasswordResetTokenUsable(record, now)
      ) {
        return null;
      }

      const consumed = await transaction.passwordResetToken.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return null;

      const passwordHash = await bcrypt.hash(password.data, 12);
      const updated = await transaction.user.updateMany({
        where: { id: record.userId, email: record.email },
        data: { passwordHash, passwordChangedAt: now },
      });
      if (updated.count !== 1) throw new InvalidResetStateError();

      return {
        id: record.user.id,
        email: record.user.email,
        name: record.user.name,
        role: record.user.role,
      };
    });
  } catch (error) {
    if (error instanceof InvalidResetStateError) return null;
    throw error;
  }
}
