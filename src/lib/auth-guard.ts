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
  // Admin MFA state (PR-10), re-read from the DB on every request alongside
  // the role. Null for customers and for admins who never enrolled.
  mfaEnabledAt: Date | null;
  mfaLastVerifiedAt: Date | null;
}

/**
 * Decide whether MFA is verified for a session issued at `iat` (seconds).
 * The guard requires lastVerifiedAt to be after the session's issued-at
 * time, so each new login must verify MFA again — the same pattern as
 * PR-09's passwordChangedAt. When either value is missing the check cannot
 * apply and the session is not MFA-verified.
 */
export function isMfaVerifiedForSession(
  lastVerifiedAt: Date | null,
  iat: number | undefined
): boolean {
  if (!lastVerifiedAt || typeof iat !== "number") return false;
  return lastVerifiedAt.getTime() > iat * 1000;
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
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      passwordChangedAt: true,
      // Admin MFA state (PR-10). The secret is never selected here — only
      // the timestamps the guard needs to decide enforcement.
      adminMfa: { select: { enabledAt: true, lastVerifiedAt: true } },
    },
  });
  if (!user) return null;
  // Invalidate sessions issued at or before a password change (PR-09). The
  // user must sign in again with the new password. When the session carries
  // no issued-at time (pre-PR-09 token), the check cannot apply and the
  // session stays valid — the token still expires on its own 7-day maxAge.
  if (isSessionInvalidatedByPasswordChange(user.passwordChangedAt, session.iat)) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mfaEnabledAt: user.adminMfa?.enabledAt ?? null,
    mfaLastVerifiedAt: user.adminMfa?.lastVerifiedAt ?? null,
  };
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

export class MfaRequiredError extends AuthError {
  code: "MFA_ENROLLMENT_REQUIRED" | "MFA_VERIFICATION_REQUIRED";
  constructor(code: "MFA_ENROLLMENT_REQUIRED" | "MFA_VERIFICATION_REQUIRED", message: string, status: number) {
    super(message, status);
    this.code = code;
  }
}

/**
 * Require an administrator whose MFA is enabled AND verified for this
 * session (PR-10). Used by the admin panel and all admin API routes except
 * the MFA setup/verify routes themselves (which use requireAdmin, so an
 * admin can enroll or verify). Throws MfaRequiredError with a machine-
 * readable code so callers can redirect to the right page:
 * - MFA_ENROLLMENT_REQUIRED (403): the admin has not enabled MFA yet.
 * - MFA_VERIFICATION_REQUIRED (401): MFA is enabled but this session has
 *   not verified it yet (lastVerifiedAt is not after the session's iat).
 * Customer accounts are never subject to this check.
 */
export async function requireAdminMfaVerified(): Promise<SessionUser> {
  const user = await requireAdmin();
  if (!user.mfaEnabledAt) {
    throw new MfaRequiredError(
      "MFA_ENROLLMENT_REQUIRED",
      "Administrator MFA is required. Please set up multi-factor authentication.",
      403
    );
  }
  const session = await getRequestSession();
  if (!isMfaVerifiedForSession(user.mfaLastVerifiedAt, session?.iat)) {
    throw new MfaRequiredError(
      "MFA_VERIFICATION_REQUIRED",
      "Please verify your multi-factor authentication code to continue.",
      401
    );
  }
  return user;
}
