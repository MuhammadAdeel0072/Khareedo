// Khareedo authentication — NextAuth v4 (JWT strategy, no adapter).
// Credentials provider works out of the box with seeded accounts (D-11);
// GoogleProvider activates automatically when OAuth env keys exist (FR-03).
// Production note: swap to Supabase Auth behind the same interface (see docs).
import { randomUUID } from "node:crypto";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { Prisma } from "../../generated/postgres-client";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { findUserByEmail } from "@/services/auth-users.service";
import { verifyEmailTokenForLogin } from "@/services/email-verification.service";
import { ADMIN_AUDIT_ACTIONS, recordAdminAuditBestEffort } from "@/services/admin-audit.service";
import { encodeSessionToken } from "@/lib/session-token";
import { isHttpsDeployment } from "@/lib/site-url";
import { clientIp } from "@/lib/rate-limit";
import {
  LOGIN_RATE_LIMIT_ERROR,
  hashLoginEmail,
  isLoginRateLimited,
  recordLoginFailure,
} from "@/lib/login-rate-limit";

const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleEnabled = Boolean(googleId && googleSecret);
const SLOW_AUTH_OPERATION_THRESHOLD_MS = 1_000;

export const googleSignInEnabled = googleEnabled;

async function timeGoogleAuthOperation<T>(
  operation: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs >= SLOW_AUTH_OPERATION_THRESHOLD_MS) {
      console.warn(
        `[performance:slow] operation=google-auth-${operation} durationMs=${durationMs}`
      );
    }
  }
}

// Fail fast on a missing auth secret — without it NextAuth's own handlers run
// on an ephemeral key while getToken/getServerSession receive `undefined`,
// so every protected route silently rejects valid sessions (audit P0 fix).
const AUTH_SECRET = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
if (!AUTH_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "KHAREEDO CONFIG ERROR: NEXTAUTH_SECRET is not set. " +
        "Generate one with `openssl rand -base64 32` and add it to the environment."
    );
  }
  console.warn("[auth] NEXTAUTH_SECRET missing in development — sessions will not work across guards.");
}

// A short secret is weak key material for the session JWTs, so warn loudly.
// This is a warning, not a throw: the CI build step uses an 18-character
// dummy secret (ci.yml), and a hard gate here would break CI until that
// dummy is lengthened — a one-line change for the operator (see the PR
// body). Production operators must use 32+ characters
// (`openssl rand -base64 32`).
if (AUTH_SECRET && AUTH_SECRET.length < 32) {
  console.error(
    "[auth] SECURITY: NEXTAUTH_SECRET is shorter than 32 characters. " +
      "Generate a 32+ character secret with `openssl rand -base64 32`."
  );
}

// NEXTAUTH_URL validation (Phase 2, area F — H-3-G1). Production must be
// HTTPS with NEXTAUTH_URL set to the https origin: without it, NextAuth
// derives the origin from request headers and serves the session cookie
// without Secure. A non-localhost http:// URL in production is a
// misconfiguration and fails fast; an unset NEXTAUTH_URL in production
// warns loudly but does not throw, so plain-HTTP preview deployments
// (which run NODE_ENV=production on localhost) keep working.
if (process.env.NODE_ENV === "production") {
  const nextAuthUrl = process.env.NEXTAUTH_URL;
  if (nextAuthUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(nextAuthUrl);
    } catch {
      // An unparseable NEXTAUTH_URL is NextAuth's problem to report; do not
      // mask it with a second error here.
    }
    if (
      parsed?.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
    ) {
      throw new Error(
        "KHAREEDO CONFIG ERROR: NEXTAUTH_URL must be an https:// origin in " +
          "production (plain HTTP is only allowed for localhost dev/preview). " +
          "Set NEXTAUTH_URL to the production https origin."
      );
    }
  } else {
    console.warn(
      "[auth] NEXTAUTH_URL is not set in production — the session cookie " +
        "will not be Secure and NextAuth derives the origin from request " +
        "headers. Set NEXTAUTH_URL to the production https origin."
    );
  }
}

const providers: NonNullable<NextAuthOptions["providers"]> = [
  CredentialsProvider({
    name: "Email & Password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials, req) {
      if (!credentials?.email || !credentials?.password) return null;
      const email = credentials.email.trim().toLowerCase();
      // Failed-login rate limiting (Phase 2, area A — H-A). The budget is
      // checked BEFORE the database lookup and bcrypt so a locked-out
      // attempt fails fast without burning a bcrypt.compare, and only
      // FAILED attempts consume a slot. When either bucket is exhausted,
      // authorize throws: NextAuth surfaces the message as
      // `?error=TooManyLoginAttempts` and the login form shows a specific
      // message. Ordinary failures still return null (generic response, no
      // enumeration oracle). `req.headers` is the plain header record
      // NextAuth passes to authorize; clientIp handles both it and Headers.
      const ip = clientIp(req?.headers ?? {});
      const emailHash = hashLoginEmail(email);
      const limited = isLoginRateLimited(ip, emailHash);
      if (limited.limited) {
        throw new Error(LOGIN_RATE_LIMIT_ERROR);
      }
      const user = await findUserByEmail(email);
      if (!user?.passwordHash || !user.emailVerified) {
        recordLoginFailure(ip, emailHash);
        return null;
      }
      const valid = await bcrypt.compare(credentials.password, user.passwordHash);
      if (!valid) {
        recordLoginFailure(ip, emailHash);
        return null;
      }
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
      } as unknown as import("next-auth").User;
    },
  }),
  CredentialsProvider({
    id: "email-verification",
    name: "Email Verification",
    credentials: {
      token: { label: "Verification token", type: "text" },
    },
    async authorize(credentials) {
      if (!credentials?.token) return null;
      return verifyEmailTokenForLogin(credentials.token);
    },
  }),
];

if (googleEnabled) {
  providers.push(
    GoogleProvider({
      clientId: googleId as string,
      clientSecret: googleSecret as string,
    })
  );
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 }, // 7 days
  // Custom encode (PR-25): the default NextAuth encode stamps a fresh
  // `iat`/`exp` on every encode, so `GET /api/auth/session` re-issued a
  // stolen token with fresh timestamps and a password reset could not kill
  // it. encodeSessionToken preserves the original `iat`/`exp` when
  // re-encoding an existing token, so a session can never be extended past
  // its original expiry. `decode` stays the library default.
  jwt: { maxAge: 60 * 60 * 24 * 7, encode: encodeSessionToken },
  // Session cookie flags (Phase 2, area F — H-3-G1). NextAuth's defaults
  // are HttpOnly + SameSite=Lax, which are kept; the Secure flag and the
  // __Secure- cookie name are set explicitly from the deployment signal
  // (isHttpsDeployment) instead of relying on the library's internal
  // derivation, so the decision is visible and testable. Over HTTPS the
  // cookie is __Secure-next-auth.session-token with Secure; over plain
  // HTTP (dev/preview) it stays the plain name without Secure, so sign-in
  // keeps working there.
  cookies: {
    sessionToken: {
      name: isHttpsDeployment()
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isHttpsDeployment(),
      },
    },
  },
  secret: AUTH_SECRET,
  pages: { signIn: "/login", error: "/login" },
  providers,
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;

      const requestId = randomUUID();
      const callbackStartedAt = performance.now();
      try {
        const googleProfile = profile as (typeof profile & { email_verified?: boolean }) | undefined;
        const email = user.email?.trim().toLowerCase();
        if (!email || googleProfile?.email_verified !== true) {
          return "/login?error=GoogleEmailNotVerified";
        }

        const providerAccountId = account.providerAccountId;
        const linkedAccount = await timeGoogleAuthOperation(
          "oauth-account-lookup",
          () =>
            db.oAuthAccount.findUnique({
              where: {
                provider_providerAccountId: {
                  provider: "google",
                  providerAccountId,
                },
              },
              include: { user: true },
            })
        );

        if (linkedAccount) {
          user.id = linkedAccount.user.id;
          user.role = linkedAccount.user.role;
          return true;
        }

        const matchingUser = await timeGoogleAuthOperation(
          "existing-user-lookup",
          () => findUserByEmail(email)
        );
        if (matchingUser) return "/login?error=OAuthAccountNotLinked";

        try {
          const localUser = await timeGoogleAuthOperation(
            "user-and-oauth-account-creation-transaction",
            () =>
              db.$transaction(async (transaction) => {
                const createdUser = await transaction.user.create({
                  data: {
                    email,
                    name: user.name ?? email.split("@")[0],
                    image: user.image,
                    emailVerified: new Date(),
                  },
                });
                await transaction.oAuthAccount.create({
                  data: {
                    userId: createdUser.id,
                    provider: "google",
                    providerAccountId,
                  },
                });
                return createdUser;
              })
          );
          user.id = localUser.id;
          user.role = localUser.role;
          return true;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
            throw error;
          }

          const racedAccount = await timeGoogleAuthOperation(
            "oauth-account-race-lookup",
            () =>
              db.oAuthAccount.findUnique({
                where: {
                  provider_providerAccountId: {
                    provider: "google",
                    providerAccountId,
                  },
                },
                include: { user: true },
              })
          );
          if (!racedAccount) return "/login?error=OAuthAccountNotLinked";
          user.id = racedAccount.user.id;
          user.role = racedAccount.user.role;
          return true;
        }
      } finally {
        const durationMs = Math.round(performance.now() - callbackStartedAt);
        if (durationMs >= SLOW_AUTH_OPERATION_THRESHOLD_MS) {
          console.warn(
            `[performance:slow] operation=google-signin-callback durationMs=${durationMs}`
          );
        }
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role ?? "CUSTOMER";
        token.sub = user.id;
        // Session identifier (Phase 2, area B — M-4). Minted ONCE at
        // sign-in and carried unchanged afterwards. It must NOT be minted
        // here on every call: the guard binds an MFA verification to the
        // session that performed it, so the id has to be stable for the
        // session's whole lifetime. Why a custom `sid` claim and not the
        // standard `jti`: NextAuth's encoder stamps a fresh random `jti`
        // on EVERY encode, so any `jti` set here would be silently
        // overwritten. `sid` survives re-encoding (PR-25's custom encoder
        // preserves every claim), so it is stable across /api/auth/session
        // refreshes. Sessions issued before this change carry no `sid`;
        // the guard fails closed for them and the admin re-verifies once
        // after signing in again.
        token.sid = randomUUID();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub as string;
        session.user.role = (token.role as string) ?? "CUSTOMER";
      }
      // Expose the JWT issued-at so the auth guard can invalidate sessions
      // issued before a password change (PR-09). NextAuth v4 JWTs are not
      // revocable, so this is how a reset signs out existing sessions.
      if (typeof token.iat === "number") session.iat = token.iat;
      // Expose the session id so the MFA guard can bind a verification to
      // this exact session (Phase 2, area B). Absent on pre-change tokens.
      if (typeof token.sid === "string") session.sid = token.sid;
      return session;
    },
  },
  // Admin sign-ins are written to the append-only audit log (PR-12).
  // The event has no request context (no IP/user-agent), so only the admin
  // id, action, and target are recorded. The write goes through the
  // audit service's best-effort path: a failed write is surfaced through
  // error monitoring (captureError, AUDIT_WRITE_FAILED) and can never
  // throw, so it can never break sign-in.
  events: {
    async signIn({ user }) {
      const role = (user as { role?: string } | null)?.role;
      if (role !== "ADMIN" || !user.id) return;
      await recordAdminAuditBestEffort(
        { adminUserId: user.id },
        {
          action: ADMIN_AUDIT_ACTIONS.AUTH_ADMIN_LOGIN,
          targetType: "User",
          targetId: user.id,
        }
      );
    },
  },
};

/** Is Google sign-in available in this deployment? */
export function isGoogleEnabled(): boolean {
  return googleEnabled;
}
