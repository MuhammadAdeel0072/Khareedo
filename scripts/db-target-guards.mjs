// Fail-closed guards for destructive database operations (PR-07, O-03).
//
// Every check is a pure function taking `env` (and argv) as arguments, so
// unit tests exercise the exact code path the scripts use — no database
// needed. A check returns either
//   { status: "ok", ... }
// or
//   { status: "refused", reason: "..." }
// Callers print the reason and exit 1; they never fall back to another
// database, never guess a target, and never proceed on a refusal.
//
// The safety model is small and deliberate:
//   - Destructive operations (db:push, db:reset, db:migrate, dev cleanup
//     scripts) only ever target a LOCAL SQLite file. Supabase PostgreSQL
//     is the application database and is never a valid target for them.
//   - Production is always refused, even for a local file.
//   - An explicit opt-in is required for the Prisma commands.
//   - Cleanup scripts are dry-run by default and only delete with --apply.
export const DESTRUCTIVE_ALLOW_ENV = "DB_DESTRUCTIVE_ALLOW";
export const DESTRUCTIVE_ALLOW_VALUE = "1";

/** Resolve a `file:` URL (absolute or repo-relative, e.g. `file:./dev.db`) to an absolute path. */
export function resolveFileUrlPath(raw) {
  const withoutScheme = raw.slice("file:".length);
  let pathname = withoutScheme;
  try {
    const parsed = new URL(raw);
    if (parsed.pathname && parsed.pathname !== "/") pathname = parsed.pathname;
  } catch {
    // Not a parseable URL; fall through with the raw remainder.
  }
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep the raw remainder if it is not valid percent-encoding.
  }
  return decoded;
}

/**
 * Validate that the environment points at a local SQLite file suitable for
 * a destructive operation. Refuses production, a missing DATABASE_URL, and
 * any non-`file:` URL (including every PostgreSQL URL).
 */
export function checkLocalSqliteTarget(env = process.env) {
  if (env.NODE_ENV === "production") {
    return {
      status: "refused",
      reason: "NODE_ENV is production; destructive database operations are never allowed in production.",
    };
  }
  const raw = env.DATABASE_URL;
  if (!raw) {
    return {
      status: "refused",
      reason: "DATABASE_URL is not set; refusing to guess a database target.",
    };
  }
  if (!raw.startsWith("file:")) {
    const scheme = raw.split(":")[0] || "(none)";
    return {
      status: "refused",
      reason: `DATABASE_URL must be a local file: URL; got scheme "${scheme}". Destructive operations never target PostgreSQL or any network database.`,
    };
  }
  const path = resolveFileUrlPath(raw);
  if (!path) {
    return { status: "refused", reason: "DATABASE_URL is a file: URL with an empty path." };
  }
  return { status: "ok", databasePath: path };
}

/**
 * Validate the explicit opt-in for destructive Prisma commands. The operator
 * must set DB_DESTRUCTIVE_ALLOW=1 exactly; anything else (including "true",
 * "yes", or "0") refuses.
 */
export function checkDestructiveOptIn(env = process.env) {
  if (env[DESTRUCTIVE_ALLOW_ENV] !== DESTRUCTIVE_ALLOW_VALUE) {
    return {
      status: "refused",
      reason: `Destructive database commands require ${DESTRUCTIVE_ALLOW_ENV}=${DESTRUCTIVE_ALLOW_VALUE} exactly.`,
    };
  }
  return { status: "ok" };
}

/**
 * Resolve the run mode for cleanup scripts from argv. Dry-run is the
 * default; --apply deletes for real. Passing both --apply and --dry-run is
 * contradictory and refuses.
 */
export function resolveRunMode(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply && dryRun) {
    return {
      status: "refused",
      reason: "Pass either --apply or --dry-run, not both.",
    };
  }
  return { status: "ok", mode: apply ? "apply" : "dry-run" };
}

/**
 * Validate the base URL of a live audit script. Audit scripts only ever talk
 * to a local development app; any non-localhost base (including a production
 * host) refuses.
 */
export function checkLocalBaseUrl(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return { status: "refused", reason: `Base URL "${base}" is not a valid URL.` };
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "http:" || !localHost) {
    return {
      status: "refused",
      reason: `Audit scripts only target a local development app (http://localhost:*); got "${base}".`,
    };
  }
  return { status: "ok", baseUrl: base };
}
