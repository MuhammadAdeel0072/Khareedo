// Operator break-glass reset for administrator MFA — thin CLI wrapper
// around src/lib/admin-mfa-reset.ts.
//
// Usage (from the repo root, with the production .env — see
// docs/ADMIN-MFA.md "Authenticator recovery" before running this):
//   ADMIN_MFA_RESET_ALLOW=1 npx tsx --env-file=.env scripts/reset-admin-mfa.ts --email admin@khareedo.pk --dry-run
//   ADMIN_MFA_RESET_ALLOW=1 npx tsx --env-file=.env scripts/reset-admin-mfa.ts --email admin@khareedo.pk --apply --confirm
//   ADMIN_MFA_RESET_ALLOW=1 bun scripts/reset-admin-mfa.ts --email admin@khareedo.pk --dry-run
//   (tsx does not auto-load .env; bun loads it. Never paste the .env
//   contents, the MFA key, or any credential into chat or logs.)
//
// What it does: deletes ONLY the AdminMfa row for the named admin (its
// recovery codes cascade-delete), and writes one AdminAuditLog row
// (admin.mfa.reset) in the same transaction. The admin User row, password,
// and every other row are untouched. After the reset the admin signs in
// with their password and must enroll a fresh authenticator at
// /admin/mfa/setup — there is no bypass and MFA stays mandatory.
//
// Safeguards, in order (each refusal prints a reason and exits 1):
//   1. SUPABASE_POSTGRES_URL must be a PostgreSQL URL on a Supabase host
//      matching the project named by NEXT_PUBLIC_SUPABASE_URL. A missing
//      URL, a file: (SQLite) URL, a loopback/local host, or a different
//      Supabase project all refuse. DATABASE_URL is never read, so the
//      local SQLite database can never be the target by accident.
//   2. ADMIN_MFA_RESET_ALLOW must be exactly "1" on every run.
//   3. --dry-run is the default (read-only: prints what --apply would
//      delete, writes nothing). --apply additionally requires --confirm.
//   4. The named account must exist, be unique, be an ADMIN, and have an
//      MFA enrollment — otherwise it refuses and writes nothing.
//
// The script prints only the target hostname (never the connection URL),
// the admin email, the user id, the MFA row id, and code counts. It never
// prints secrets, passwords, hashes, TOTP secrets, recovery codes, or
// database credentials. The database client is imported only AFTER the
// guards pass, so a refusal never leaks an import-time error either.
// This script requires the generated Postgres client first:
//   npm run db:generate:postgres
import {
  checkResetOptIn,
  checkSupabasePostgresTarget,
  parseResetArgs,
  resetAdminMfa,
  resolveResetRunMode,
  type MfaResetStore,
} from "../src/lib/admin-mfa-reset";

function fail(message: string): never {
  console.error(`reset-admin-mfa: refused: ${message}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);

  const target = checkSupabasePostgresTarget(process.env);
  if (!target.ok) fail(target.reason);

  const optIn = checkResetOptIn(process.env);
  if (!optIn.ok) fail(optIn.reason);

  const mode = resolveResetRunMode(argv);
  if (!mode.ok) fail(mode.reason);

  const { email, confirm } = parseResetArgs(argv);
  if (!email) fail("An admin email address is required: --email admin@khareedo.pk");
  if (mode.mode === "apply" && !confirm) {
    fail(
      "Refusing to reset MFA without --confirm: re-run with --apply --confirm " +
        "after verifying the admin's identity out-of-band (see docs/ADMIN-MFA.md).",
    );
  }

  // The app Prisma client (src/lib/db) reads SUPABASE_POSTGRES_URL at
  // import time, so it is imported only after every guard above has
  // passed — a refusal must never surface as a database error.
  const { db } = await import("../src/lib/db");
  try {
    const result = await resetAdminMfa({
      store: db as unknown as MfaResetStore,
      email,
      dryRun: mode.mode === "dry-run",
    });
    if (result.status === "refused") fail(result.reason);
    console.log(
      [
        `reset-admin-mfa: target Supabase host: ${target.host} (project: ${target.projectRef})`,
        `reset-admin-mfa: admin: ${result.email} (user id: ${result.userId})`,
        `reset-admin-mfa: MFA row: ${result.mfaId}`,
      ].join("\n"),
    );
    if (result.status === "dry-run") {
      console.log(
        `reset-admin-mfa: DRY RUN — would delete the MFA enrollment and ${result.recoveryCodesTotal} recovery code(s) (${result.recoveryCodesUnused} unused). Nothing was written. Re-run with --apply --confirm to perform the reset.`,
      );
    } else {
      console.log(
        `reset-admin-mfa: MFA reset complete — deleted the MFA enrollment and ${result.recoveryCodesDeleted} recovery code(s); audit event "${result.auditAction}" recorded. The admin must now sign in and enroll a fresh authenticator at /admin/mfa/setup.`,
      );
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(`reset-admin-mfa: failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
