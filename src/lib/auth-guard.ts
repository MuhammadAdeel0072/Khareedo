// Server-side session guards (NFR-10/11/12, FR-38, BR-14).
// Always resolves the session on the SERVER — never trust client-sent roles/ids.
import { getServerSession } from "next-auth";
import { cache } from "react";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  role: string;
}

/**
 * Decide whether a JWT session is invalidated by a password change (PR-09).
 * NextAuth v4 JWTs are not revocable, so a reset records passwordChangedAt
 * and any session issued at or before that moment is rejected. `iat` is the
 * JWT issued-at time in seconds; passwordChangedAt is a Date. When either
 * value is missing the check cannot apply and the session stays valid.
 */
export function isSessionInvalidatedByPasswordChange(
  passwordChangedAt: Date | null,
  iat: number | undefined
): boolean {
  if (!passwordChangedAt || typeof iat !== "number") return false;
  return passwordChangedAt.getTime() >= iat * 1000;
}

const readRequestSession = cache(async () => getServerSession(authOptions));

const readRequestUser = cache(async (): Promise<SessionUser | null> => {
  const session = await readRequestSession();
  if (!session?.user?.id) return null;
  // Re-verify role from DB (protects against stale JWT role claims)
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, role: true, passwordChangedAt: true },
  });
  if (!user) return null;
  // Invalidate sessions issued at or before a password change (PR-09). The
  // user must sign in again with the new password. When the session carries
  // no issued-at time (pre-PR-09 token), the check cannot apply and the
  // session stays valid — the token still expires on its own 7-day maxAge.
  if (isSessionInvalidatedByPasswordChange(user.passwordChangedAt, session.iat)) {
    return null;
  }
  return { id: user.id, email: user.email, name: user.name, role: user.role };
});

export function getRequestSession() {
  return readRequestSession();
}

export function getSessionUser(): Promise<SessionUser | null> {
  return readRequestUser();
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Please sign in to continue", 401);
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Please sign in to continue", 401);
  if (user.role !== "ADMIN") throw new AuthError("Administrator access required", 403);
  return user;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}
