// Email verification tokens (PR-09 pattern; delivery moved onto the outbox
// in Phase 3 Chunk 7, M-24).
//
// Registration used to send the verification email synchronously, so a
// transient SMTP failure failed the whole registration. Registration and
// resend now only enqueue an EMAIL_VERIFICATION outbox row; the worker
// (email-outbox.service.ts) looks the account up at delivery time,
// generates the token then, stores only its hash, and sends the email with
// retries. A failed SMTP send therefore never fails registration or resend,
// and the admin outbox viewer surfaces rows that exhaust their retries.
//
// Token shape is unchanged: cryptographically secure random token, only its
// SHA-256 hash stored, single-use (consumedAt) and expiring (24h). The raw
// token is emailed once and never persisted or logged. The verification link
// uses the callbackUrl carried in the outbox payload when the request
// supplied one (Chunk 7-final), falling back to the default "/account".
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { enqueueVerificationEmail } from "@/services/email-outbox.service";

export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashVerificationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function isVerificationTokenUsable(
  token: { expiresAt: Date; consumedAt: Date | null },
  now = new Date()
) {
  return token.consumedAt === null && token.expiresAt.getTime() > now.getTime();
}

/**
 * Enqueue a verification email for a newly registered (or still unverified)
 * user. Never sends synchronously and never throws for SMTP reasons — the
 * worker delivers it. The caller has already established that this user
 * needs verification; eligibility (unverified credentials account) is
 * re-checked by the worker at delivery, so a stale row is discarded there.
 * A caller supplied callbackUrl is carried in the outbox payload (Chunk
 * 7-final) so the verification link lands where the caller asked instead
 * of the default "/account".
 */
export async function sendRegistrationVerification(
  user: { id: string; email: string; name: string | null },
  callbackUrl?: string | null
) {
  await enqueueVerificationEmail({ email: user.email, callbackUrl: callbackUrl ?? null });
}

/**
 * Enqueue a verification email for a resend request. Same shape as
 * registration: no account lookup here, no synchronous send. The worker
 * looks the account up at delivery and silently discards unknown,
 * OAuth-only, and already-verified addresses — the route's response is
 * identical either way, so resend cannot probe which emails are registered.
 * A caller supplied callbackUrl is carried in the outbox payload.
 */
export async function resendVerificationEmail(email: string, callbackUrl?: string | null) {
  await enqueueVerificationEmail({ email: email.trim().toLowerCase(), callbackUrl: callbackUrl ?? null });
}

class InvalidVerificationStateError extends Error {}

async function redeemVerificationToken(token: string) {
  if (!token || token.length > 256) return null;
  const tokenHash = hashVerificationToken(token);
  const now = new Date();

  try {
    return await db.$transaction(async (transaction) => {
      const record = await transaction.verificationToken.findUnique({
        where: { tokenHash },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              emailVerified: true,
              passwordHash: true,
              name: true,
              image: true,
              role: true,
            },
          },
        },
      });
      if (
        !record ||
        record.user.role !== "CUSTOMER" ||
        !record.user.passwordHash ||
        record.user.emailVerified ||
        !isVerificationTokenUsable(record, now)
      ) {
        return null;
      }

      const consumed = await transaction.verificationToken.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return null;

      const verified = await transaction.user.updateMany({
        where: {
          id: record.userId,
          email: record.email,
          emailVerified: null,
          role: "CUSTOMER",
        },
        data: { emailVerified: now },
      });
      if (verified.count !== 1) throw new InvalidVerificationStateError();

      return transaction.user.findUnique({
        where: { id: record.userId },
        select: {
          id: true,
          email: true,
          name: true,
          image: true,
          role: true,
          emailVerified: true,
          passwordHash: true,
        },
      });
    });
  } catch (error) {
    if (error instanceof InvalidVerificationStateError) return null;
    throw error;
  }
}

export async function verifyEmailTokenForLogin(token: string) {
  const user = await redeemVerificationToken(token);
  if (!user || user.role !== "CUSTOMER" || !user.passwordHash || !user.emailVerified) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    role: "CUSTOMER",
  };
}

export async function verifyEmailToken(token: string) {
  return Boolean(await verifyEmailTokenForLogin(token));
}
