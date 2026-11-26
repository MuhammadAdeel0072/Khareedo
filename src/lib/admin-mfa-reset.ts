// Operator break-glass reset for administrator MFA.
//
// This module is the code behind the documented break-glass procedure
// (docs/ADMIN-MFA.md): an admin who has lost both their authenticator and
// all recovery codes has no in-app path back in — every in-app MFA flow
// requires a valid current code or an unused recovery code, by design.
// The only recovery is for an operator with database access to delete the
// admin's AdminMfa row, after which the admin signs in with their password
// and is redirected to /admin/mfa/setup to enroll a fresh authenticator.
//
// Why a scripted reset instead of raw SQL:
// - The raw SQL in the docs has no audit event, no operator confirmation,
//   no database-target safeguard, and no identity check in code. This
//   module adds all four, and the thin CLI wrapper in
//   scripts/reset-admin-mfa.ts is the only entry point.
// - It never touches the User row, never prints secrets, and never
//   creates a bypass: deleting the row returns the admin to the
//   enrollment gate (MFA_ENROLLMENT_REQUIRED), so a fresh authenticator
//   is mandatory at the next login.
//
// Safety model (mirrors src/lib/seed-guards.ts and
// scripts/db-target-guards.mjs — pure functions taking env/argv, so unit
// tests exercise the exact decisions the script makes):
// - Target: SUPABASE_POSTGRES_URL must be a PostgreSQL URL whose host is
//   a Supabase host (.pooler.supabase.com or .supabase.co) AND matches
//   the project named by NEXT_PUBLIC_SUPABASE_URL (same check as
//   scripts/deploy-postgres-migrations.mjs). A missing URL, a file: URL
//   (SQLite), a loopback/local host, or a different Supabase project all
//   refuse. The script never reads DATABASE_URL, so the local SQLite
//   database can never be the target by accident.
// - Opt-in: ADMIN_MFA_RESET_ALLOW must be exactly "1" on every run.
// - Run mode: --dry-run is the default (read-only lookup, prints what
//   WOULD be deleted, writes nothing). --apply performs the reset and
//   additionally requires --confirm.
// - The live application database IS the intended target here (unlike
//   the seed / destructive-DB guards, which are local-SQLite-only): the
//   lockout lives in Supabase, so refusing production would defeat the
//   procedure. The confirmations above — not NODE_ENV — are the guard.
//
// This module deliberately imports nothing from @/lib/db or
// @/services/admin-audit.service: both read SUPABASE_POSTGRES_URL at
// import time, which would make the pure guard functions untestable
// without a configured database. The reset function takes its database
// client as an argument instead (the script passes the app Prisma
// client after the guards pass; tests pass a mock or the disposable
// SQLite client). The audit action string below must stay in sync with
// ADMIN_AUDIT_ACTIONS.MFA_RESET in src/services/admin-audit.service.ts.

export const MFA_RESET_ALLOW_ENV = "ADMIN_MFA_RESET_ALLOW";
export const MFA_RESET_ALLOW_VALUE = "1";
export const MFA_RESET_AUDIT_ACTION = "admin.mfa.reset";

export type MfaResetCheck = { ok: true } | { ok: false; reason: string };

/** Extract the Supabase project ref (first hostname label) from a URL. */
function supabaseProjectRef(raw: string): string | null {
  try {
    return new URL(raw).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Validate that the environment points at the live Supabase PostgreSQL
 * database for the project named by NEXT_PUBLIC_SUPABASE_URL.
 *
 * Refuses when:
 * - SUPABASE_POSTGRES_URL is missing (ambiguous target — fail safe), or
 * - it is not a PostgreSQL URL (this rejects file: SQLite URLs outright),
 * - its host is not a Supabase host (this rejects loopback/local hosts
 *   and any other remote host), or it has a fragment, or
 * - NEXT_PUBLIC_SUPABASE_URL is missing, or
 * - the database host does not match that Supabase project (same
 *   project-match check as scripts/deploy-postgres-migrations.mjs).
 *
 * Never echoes the URL value in a refusal reason (it carries credentials).
 * Only the rejected hostname / project ref is named.
 */
export function checkSupabasePostgresTarget(
  env: Readonly<Record<string, string | undefined>>
): MfaResetCheck & { host?: string; projectRef?: string } {
  const raw = env.SUPABASE_POSTGRES_URL;
  if (!raw) {
    return {
      ok: false,
      reason:
        "SUPABASE_POSTGRES_URL is not set; refusing to guess a database target.",
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "SUPABASE_POSTGRES_URL is not a valid URL." };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    const scheme = raw.split(":")[0] || "(none)";
    return {
      ok: false,
      reason:
        `SUPABASE_POSTGRES_URL must be a PostgreSQL URL; got scheme "${scheme}". ` +
        "SQLite (file:) and local databases are never valid targets for an MFA reset.",
    };
  }
  const isSupabaseHost =
    url.hostname.endsWith(".pooler.supabase.com") ||
    url.hostname.endsWith(".supabase.co");
  if (!isSupabaseHost) {
    return {
      ok: false,
      reason:
        `SUPABASE_POSTGRES_URL must point at a Supabase host (.pooler.supabase.com or .supabase.co); got host "${url.hostname}". ` +
        "Local and loopback databases are never valid targets for an MFA reset.",
    };
  }
  if (url.hash !== "") {
    return {
      ok: false,
      reason: "SUPABASE_POSTGRES_URL must not have a fragment.",
    };
  }
  const projectUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!projectUrl) {
    return {
      ok: false,
      reason:
        "NEXT_PUBLIC_SUPABASE_URL is not set; the Supabase project cannot be verified, so refusing.",
    };
  }
  const projectRef = supabaseProjectRef(projectUrl);
  if (!projectRef) {
    return {
      ok: false,
      reason: "NEXT_PUBLIC_SUPABASE_URL is not a valid URL; refusing.",
    };
  }
  const targetMatches =
    url.hostname === `db.${projectRef}.supabase.co` ||
    url.username.endsWith(`.${projectRef}`) ||
    url.hostname.startsWith(`${projectRef}.`);
  if (!targetMatches) {
    return {
      ok: false,
      reason:
        `SUPABASE_POSTGRES_URL does not match the Supabase project "${projectRef}" named by NEXT_PUBLIC_SUPABASE_URL; refusing.`,
    };
  }
  return { ok: true, host: url.hostname, projectRef };
}

/**
 * Validate the explicit opt-in. The operator must set
 * ADMIN_MFA_RESET_ALLOW=1 exactly on every run; anything else (including
 * "true", "yes", or "0") refuses. There is no persistent "reset enabled"
 * state.
 */
export function checkResetOptIn(
  env: Readonly<Record<string, string | undefined>>
): MfaResetCheck {
  if (env[MFA_RESET_ALLOW_ENV] !== MFA_RESET_ALLOW_VALUE) {
    return {
      ok: false,
      reason:
        `An MFA reset requires deliberate opt-in: re-run with ${MFA_RESET_ALLOW_ENV}=${MFA_RESET_ALLOW_VALUE}. ` +
        "See docs/ADMIN-MFA.md.",
    };
  }
  return { ok: true };
}

/**
 * Resolve the run mode from argv. Dry-run is the default; --apply
 * performs the reset. Passing both is contradictory and refuses.
 */
export function resolveResetRunMode(
  argv: readonly string[] = []
): { ok: true; mode: "dry-run" | "apply" } | { ok: false; reason: string } {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply && dryRun) {
    return { ok: false, reason: "Pass either --apply or --dry-run, not both." };
  }
  return { ok: true, mode: apply ? "apply" : "dry-run" };
}

/** Parse --email=<address> / --email <address> and --confirm from argv. */
export function parseResetArgs(argv: readonly string[]): {
  email: string | undefined;
  confirm: boolean;
} {
  let email: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length);
    } else if (arg === "--email" && i + 1 < argv.length) {
      email = argv[i + 1];
      i++;
    }
  }
  return { email, confirm: argv.includes("--confirm") };
}

/** Minimal store shape for the reset. Both the app Prisma client and a
 * transaction client satisfy it, so the delete and the audit write run
 * in one transaction and roll back together. */
export type MfaResetStore = {
  user: {
    findMany: (args: {
      where: { email: string };
      select: { id: true; email: true; role: true };
    }) => Promise<{ id: string; email: string; role: string }[]>;
  };
  adminMfa: {
    findUnique: (args: {
      where: { userId: string };
    }) => Promise<{ id: string; userId: string } | null>;
    delete: (args: { where: { userId: string } }) => Promise<unknown>;
  };
  adminMfaRecoveryCode: {
    findMany: (args: {
      where: { mfaId: string };
      select: { usedAt: true };
    }) => Promise<{ usedAt: Date | null }[]>;
  };
  adminAuditLog: {
    create: (args: {
      data: {
        adminUserId: string | null;
        action: string;
        targetType: string;
        targetId: string | null;
        requestId: string | null;
        ipAddress: string | null;
        userAgent: string | null;
        metadata?: Record<string, unknown>;
      };
    }) => Promise<unknown>;
  };
  $transaction: <T>(fn: (tx: MfaResetStore) => Promise<T>) => Promise<T>;
};

export type MfaResetResult =
  | { status: "refused"; reason: string }
  | {
      status: "dry-run";
      email: string;
      userId: string;
      mfaId: string;
      recoveryCodesTotal: number;
      recoveryCodesUnused: number;
    }
  | {
      status: "reset";
      email: string;
      userId: string;
      mfaId: string;
      recoveryCodesDeleted: number;
      auditAction: string;
    };

/**
 * Reset one admin's MFA enrollment (break-glass).
 *
 * - The admin is identified by exact email (trimmed, lower-cased — the
 *   same normalisation as sign-in). Refuses when no account exists, when
 *   more than one matches (ambiguous), when the account is not an ADMIN,
 *   or when no MFA enrollment exists (nothing to reset — the admin
 *   should enroll via /admin/mfa/setup instead).
 * - The User row is never touched. Only the AdminMfa row is deleted;
 *   its recovery codes cascade-delete with it (ON DELETE CASCADE).
 * - In apply mode the delete and the audit write are one transaction:
 *   the audit row is written with adminUserId null (the actor is the
 *   shell operator, not a signed-in admin), action admin.mfa.reset,
 *   target AdminMfa / the admin's user id, and metadata carrying only
 *   the email, the fixed reason, the method, and the count of codes
 *   deleted — never a secret, code, password, or credential.
 * - In dry-run mode nothing is written: the lookup runs and the result
 *   describes what --apply would delete.
 * - After a reset the admin signs in with their password and is
 *   redirected to /admin/mfa/setup for a mandatory fresh enrollment.
 */
export async function resetAdminMfa(input: {
  store: MfaResetStore;
  email: string;
  dryRun: boolean;
}): Promise<MfaResetResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { status: "refused", reason: "A valid admin email address is required (--email)." };
  }
  const users = await input.store.user.findMany({
    where: { email },
    select: { id: true, email: true, role: true },
  });
  if (users.length === 0) {
    return { status: "refused", reason: `No account exists for email "${email}"; refusing.` };
  }
  if (users.length > 1) {
    return {
      status: "refused",
      reason: `More than one account matches email "${email}"; refusing to guess which admin to reset.`,
    };
  }
  const user = users[0];
  if (user.role !== "ADMIN") {
    return {
      status: "refused",
      reason: `Account "${email}" is not an admin (role is ${user.role}); MFA reset is admin-only.`,
    };
  }
  const mfa = await input.store.adminMfa.findUnique({ where: { userId: user.id } });
  if (!mfa) {
    return {
      status: "refused",
      reason: `Admin "${email}" has no MFA enrollment; nothing to reset. The admin should enroll via /admin/mfa/setup.`,
    };
  }
  const codes = await input.store.adminMfaRecoveryCode.findMany({
    where: { mfaId: mfa.id },
    select: { usedAt: true },
  });
  const unused = codes.filter((c) => c.usedAt === null).length;
  if (input.dryRun) {
    return {
      status: "dry-run",
      email: user.email,
      userId: user.id,
      mfaId: mfa.id,
      recoveryCodesTotal: codes.length,
      recoveryCodesUnused: unused,
    };
  }
  return input.store.$transaction(async (tx) => {
    await tx.adminMfa.delete({ where: { userId: user.id } });
    await tx.adminAuditLog.create({
      data: {
        adminUserId: null,
        action: MFA_RESET_AUDIT_ACTION,
        targetType: "AdminMfa",
        targetId: user.id,
        requestId: null,
        ipAddress: null,
        userAgent: "operator-break-glass",
        metadata: {
          email: user.email,
          reason: "authenticator-and-recovery-codes-lost",
          method: "operator-break-glass",
          codesDeleted: codes.length,
        },
      },
    });
    return {
      status: "reset",
      email: user.email,
      userId: user.id,
      mfaId: mfa.id,
      recoveryCodesDeleted: codes.length,
      auditAction: MFA_RESET_AUDIT_ACTION,
    };
  });
}
