import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { safeCallbackUrl } from "@/lib/auth-client";
import { sendVerificationEmail } from "@/services/email.service";
import { findUserByEmail } from "@/services/auth-users.service";

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

async function issueVerificationEmail(
  user: { id: string; email: string; name: string | null },
  callbackUrl = "/account"
) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashVerificationToken(token);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

  await db.$transaction(async (transaction) => {
    await transaction.verificationToken.deleteMany({ where: { userId: user.id } });
    await transaction.verificationToken.create({
      data: { userId: user.id, email: user.email, tokenHash, expiresAt },
    });
  });

  await sendVerificationEmail({
    email: user.email,
    name: user.name,
    token,
    callbackUrl: safeCallbackUrl(callbackUrl),
  });
}

export async function sendRegistrationVerification(
  user: { id: string; email: string; name: string | null },
  callbackUrl?: string
) {
  await issueVerificationEmail(user, callbackUrl);
}

export async function resendVerificationEmail(email: string, callbackUrl?: string) {
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash || user.emailVerified) return;
  await issueVerificationEmail(user, callbackUrl);
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
