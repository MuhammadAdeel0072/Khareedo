// Password reset (PR-09). Mirrors the email-verification token pattern:
// cryptographically secure random token, only its SHA-256 hash stored,
// single-use (consumedAt) and expiring. The raw token is emailed once and
// never persisted or logged.
//
// Enumeration safety (PR-09 security-review fix): the forgot-password
// endpoint must be indistinguishable for registered, unregistered, and
// OAuth-only addresses. requestPasswordReset therefore performs NO account
// lookup at all — it enqueues exactly one outbox row carrying only the
// submitted normalized email address, the same row for every valid email,
// and returns. A background worker (src/services/email-outbox.service.ts)
// performs the account lookup AFTER the HTTP request has returned, and
// silently discards unknown and OAuth-only addresses. Only eligible
// credentials accounts receive a token and an email. The synchronous
// request path used to call findUserByEmail before enqueueing, which meant
// the HTTP request still performed account-dependent database work (the
// lookup returned different results for registered and unknown addresses,
// and the outbox row stored different userId values). Identical response
// text and identical timing are not enough if the request itself still
// branches on account existence.
//
// Session invalidation: a successful reset sets passwordChangedAt, and the
// auth guard invalidates JWT sessions issued at or before that timestamp,
// because NextAuth v4 JWTs are not revocable. This is the design choice the
// Phase 0 report requires to be stated explicitly.
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
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
 * Request a password reset. Enumeration-safe: performs NO account lookup.
 * It enqueues exactly one outbox row carrying only the submitted normalized
 * email address — the same row for every valid email — and resolves (void).
 * The background worker looks the account up after the HTTP request has
 * returned and silently discards unknown and OAuth-only addresses; only
 * credentials accounts receive a token and an email. No token is created
 * here and no email is sent here.
 */
export async function requestPasswordReset(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  await enqueuePasswordResetEmail({ email: normalizedEmail });
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
