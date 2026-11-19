// NextAuth type augmentation — role + id on session/JWT.
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "CUSTOMER" | "ADMIN" | string;
    } & DefaultSession["user"];
    // JWT issued-at (seconds since epoch), set in the session callback.
    // The auth guard compares it against passwordChangedAt to invalidate
    // sessions issued before a password reset (PR-09).
    iat?: number;
    // Session identifier (Phase 2, area B — M-4), minted once at sign-in
    // in the jwt callback. The MFA guard binds a verification to this
    // exact session. Absent on tokens issued before the change.
    sid?: string;
  }
  interface User {
    role?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
    // Session identifier, minted once at sign-in (see Session.sid above).
    sid?: string;
  }
}
