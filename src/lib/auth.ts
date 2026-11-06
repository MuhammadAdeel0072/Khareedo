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

const providers: NonNullable<NextAuthOptions["providers"]> = [
  CredentialsProvider({
    name: "Email & Password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) return null;
      const email = credentials.email.trim().toLowerCase();
      const user = await findUserByEmail(email);
      if (!user?.passwordHash || !user.emailVerified) return null;
      const valid = await bcrypt.compare(credentials.password, user.passwordHash);
      if (!valid) return null;
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        role: user.role,
      } as unknown as import("next-auth").User;
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
  jwt: { maxAge: 60 * 60 * 24 * 7 },
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
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub as string;
        session.user.role = (token.role as string) ?? "CUSTOMER";
      }
      return session;
    },
  },
};

/** Is Google sign-in available in this deployment? */
export function isGoogleEnabled(): boolean {
  return googleEnabled;
}
