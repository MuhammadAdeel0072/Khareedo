import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
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

async function issueVerificationEmail(user: {
  id: string;
  email: string;
  name: string | null;
}) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashVerificationToken(token);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

  await db.$transaction(async (transaction) => {
    await transaction.verificationToken.deleteMany({ where: { userId: user.id } });
    await transaction.verificationToken.create({
      data: { userId: user.id, email: user.email, tokenHash, expiresAt },
    });
  });

  await sendVerificationEmail({ email: user.email, name: user.name, token });
}

export async function sendRegistrationVerification(user: {
  id: string;
  email: string;
  name: string | null;
}) {
  await issueVerificationEmail(user);
}

export async function resendVerificationEmail(email: string) {
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash || user.emailVerified) return;
  await issueVerificationEmail(user);
}

class InvalidVerificationStateError extends Error {}

export async function verifyEmailToken(token: string) {
  if (!token || token.length > 256) return false;
  const tokenHash = hashVerificationToken(token);
  const now = new Date();

  try {
    return await db.$transaction(async (transaction) => {
      const record = await transaction.verificationToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { emailVerified: true } } },
      });
      if (!record || record.user.emailVerified || !isVerificationTokenUsable(record, now)) {
        return false;
      }

      const consumed = await transaction.verificationToken.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return false;

      const verified = await transaction.user.updateMany({
        where: { id: record.userId, email: record.email, emailVerified: null },
        data: { emailVerified: now },
      });
      if (verified.count !== 1) throw new InvalidVerificationStateError();
      return true;
    });
  } catch (error) {
    if (error instanceof InvalidVerificationStateError) return false;
    throw error;
  }
}
