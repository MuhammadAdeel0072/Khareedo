// Guards for database seeding (PR-06).
//
// Seeding is opt-in, non-production, and local-SQLite-only by construction:
// the seed uses the SQLite Prisma client, so a `file:` DATABASE_URL is the
// only acceptable target. Anything else is refused, never worked around.
//
// These checks are pure (they take the environment as an argument) so the
// seed script and the tests exercise exactly the same decisions.

export const SEED_ALLOW_VALUE = "1";
export const MIN_SEED_PASSWORD_LENGTH = 12;
export const MAX_SEED_PASSWORD_LENGTH = 72;

/**
 * Passwords that must never seed an account. Includes the demo passwords
 * that used to be published in this repository (Admin@123 / Customer@123)
 * and other common defaults. Comparison is case-insensitive, and a password
 * is rejected when it *contains* one of these values — so "Customer@123!"
 * and "Password1234" are refused too.
 */
export const SEED_PASSWORD_DENYLIST = [
  "admin@123",
  "customer@123",
  "admin123",
  "customer123",
  "password",
  "password123",
  "password1234",
  "changeme",
  "demo123",
  "khareedo",
  "khareedo123",
  "letmein",
  "qwerty123",
  "12345678",
  "123456789",
  "1234567890",
] as const;

export type SeedCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether seeding may run at all against `env`.
 *
 * Refuses when:
 * - NODE_ENV is production (seeding is never allowed in production),
 * - SEED_ALLOW is not exactly "1" (seeding requires explicit, deliberate
 *   opt-in on every run — there is no persistent "seeding enabled" state),
 * - DATABASE_URL is missing (ambiguous target — fail safe), or
 * - DATABASE_URL is not a local SQLite `file:` URL (the seed only ever
 *   touches a local SQLite file; it must never be pointed at a network
 *   database).
 */
export function checkSeedTarget(env: NodeJS.ProcessEnv): SeedCheck {
  if (env.NODE_ENV === "production") {
    return {
      ok: false,
      reason:
        "NODE_ENV=production: seeding is never allowed in production. " +
        "Seed only a local development database.",
    };
  }
  if (env.SEED_ALLOW !== SEED_ALLOW_VALUE) {
    return {
      ok: false,
      reason:
        "Seeding requires explicit opt-in: re-run with SEED_ALLOW=1. " +
        "See docs/SEEDING.md.",
    };
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    return {
      ok: false,
      reason:
        "DATABASE_URL is not set: refusing to seed an ambiguous database " +
        "target. Set DATABASE_URL to a local SQLite file: URL.",
    };
  }
  if (!databaseUrl.startsWith("file:")) {
    return {
      ok: false,
      reason:
        "DATABASE_URL must be a local SQLite file: URL. The seed only ever " +
        "touches a local SQLite file and must never be pointed at a network " +
        "database.",
    };
  }
  return { ok: true };
}

export type SeedPasswordResult =
  | { status: "ok" }
  | { status: "missing"; reason: string }
  | { status: "invalid"; reason: string };

/**
 * Validate a password supplied for a seeded account.
 *
 * - Missing/empty: the account is simply not created (the caller skips it).
 * - Invalid: the seed must fail loudly instead of creating a weak account.
 *
 * Rules: 12–72 characters (the application caps passwords at 72, the bcrypt
 * limit) and never a published demo password or another common default —
 * rejected even as a substring of a longer password.
 */
export function validateSeedPassword(
  password: string | undefined,
  label: string,
): SeedPasswordResult {
  if (!password) {
    return {
      status: "missing",
      reason:
        `${label} is not set: no account will be created for it. Set ${label} ` +
        "to a strong password to create the account.",
    };
  }
  const lower = password.toLowerCase();
  if (
    password.length < MIN_SEED_PASSWORD_LENGTH ||
    password.length > MAX_SEED_PASSWORD_LENGTH
  ) {
    return {
      status: "invalid",
      reason:
        `${label} must be ${MIN_SEED_PASSWORD_LENGTH}–${MAX_SEED_PASSWORD_LENGTH} ` +
        "characters long.",
    };
  }
  if (
    (SEED_PASSWORD_DENYLIST as readonly string[]).some((banned) =>
      lower.includes(banned),
    )
  ) {
    return {
      status: "invalid",
      reason:
        `${label} must not be a published demo password or another common ` +
        "default. Choose a password that was never published anywhere.",
    };
  }
  return { status: "ok" };
}
