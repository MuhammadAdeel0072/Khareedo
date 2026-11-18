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
//   - The concurrency audit is the exception to the SQLite rule, because
//     its operations go through src/lib/db (PostgreSQL): its own
//     SUPABASE_POSTGRES_URL must be a loopback PostgreSQL URL, and the app
//     it talks to must confirm server-side (GET /api/db-target) that its
//     own database is loopback too — a localhost base URL proves nothing
//     about the app's database.
//   - Only genuine local `file:` URLs are accepted: no hostname/authority,
//     no query string, no fragment, no network (UNC-style) path, and no
//     malformed URL. Anything else refuses.
//   - A relative `file:` URL resolves against the Prisma schema directory
//     (prisma/), because that is where Prisma itself puts the file —
//     verified 2026-11-19: `file:./x.db` lands in prisma/ for both
//     `prisma db push` and the generated Prisma Client, from any working
//     directory. The displayed target is therefore the actual Prisma
//     target. (The WHATWG parser normalizes `file:./x.db` to `/x.db`, so
//     the relative path is recovered from the raw string, not from the
//     parsed pathname.)
//   - Production is always refused, even for a local file.
//   - An explicit opt-in is required for the Prisma commands.
//   - Cleanup scripts are dry-run by default and only delete with --apply.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const DESTRUCTIVE_ALLOW_ENV = "DB_DESTRUCTIVE_ALLOW";
export const DESTRUCTIVE_ALLOW_VALUE = "1";

// Directory of the Prisma schema (prisma/schema.prisma), anchored to this
// module (scripts/) so relative paths resolve correctly no matter where the
// caller runs from.
const PRISMA_SCHEMA_DIR = fileURLToPath(new URL("../prisma", import.meta.url));

/**
 * Resolve a `file:` URL to the absolute local path Prisma will actually
 * use, or refuse it. Accepts only genuine local SQLite file URLs:
 * absolute (`file:/tmp/x.db`, `file:///tmp/x.db`) or relative to the
 * Prisma schema directory (`file:./dev.db`, `file:dev.db`). Refuses a
 * hostname/authority (`file://server/...`, `file://localhost/...`),
 * network paths, query strings, fragments, malformed URLs, and paths
 * that do not name a file. Never echoes the URL value in a refusal reason
 * (it could carry credentials in the non-file case).
 */
export function resolveFileUrlPath(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { status: "refused", reason: "DATABASE_URL is not a valid URL." };
  }
  if (url.protocol !== "file:") {
    const scheme = raw.split(":")[0] || "(none)";
    return {
      status: "refused",
      reason: `DATABASE_URL must be a local file: URL; got scheme "${scheme}". Destructive operations never target PostgreSQL or any network database.`,
    };
  }
  // Reject any authority component. The URL parser normalizes
  // file://localhost/ to an empty hostname, so check the raw string: after
  // "file:", "//" followed by a non-"/" character is an authority
  // (a server name or localhost), while "///" is the empty authority of an
  // absolute path.
  const afterScheme = raw.slice("file:".length);
  if (/^\/\/[^/]/.test(afterScheme) || url.hostname !== "") {
    return {
      status: "refused",
      reason: "DATABASE_URL must not have a hostname/authority (file://server/... and file://localhost/... are not local SQLite targets).",
    };
  }
  if (url.search !== "") {
    return {
      status: "refused",
      reason: "DATABASE_URL must not have a query string.",
    };
  }
  if (url.hash !== "") {
    return {
      status: "refused",
      reason: "DATABASE_URL must not have a fragment.",
    };
  }
  // Strip an empty authority ("file:///path" -> "/path"). The path is
  // recovered from the raw string, not url.pathname: the parser normalizes
  // file:./x.db and file:x.db to /x.db, losing the relative form.
  let remainder = afterScheme;
  if (remainder.startsWith("//")) {
    const slash = remainder.indexOf("/", 2);
    remainder = slash === -1 ? "" : remainder.slice(slash);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(remainder);
  } catch {
    return {
      status: "refused",
      reason: "DATABASE_URL has malformed percent-encoding.",
    };
  }
  if (!decoded || decoded === "/" || decoded.endsWith("/")) {
    return {
      status: "refused",
      reason: "DATABASE_URL must name a SQLite file.",
    };
  }
  if (decoded.startsWith("//")) {
    return {
      status: "refused",
      reason: "DATABASE_URL must not be a network (UNC-style) path.",
    };
  }
  if (decoded.includes("\\")) {
    return {
      status: "refused",
      reason: "DATABASE_URL must not contain backslashes (UNC/Windows network paths are not local SQLite targets).",
    };
  }
  const absolute = decoded.startsWith("/")
    ? decoded
    : resolve(PRISMA_SCHEMA_DIR, decoded);
  return { status: "ok", path: absolute };
}

/**
 * Validate that the environment points at a local SQLite file suitable for
 * a destructive operation. Refuses production, a missing DATABASE_URL, and
 * any URL that is not a genuine local `file:` URL (including every
 * PostgreSQL URL). Returns the absolute path Prisma will actually use, so
 * callers can display the real target.
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
  const resolved = resolveFileUrlPath(raw);
  if (resolved.status !== "ok") return resolved;
  return { status: "ok", databasePath: resolved.path };
}

export const POSTGRES_URL_ENV = "SUPABASE_POSTGRES_URL";

// Hostnames accepted as loopback database targets. Same set as
// src/lib/db.ts (its sslmode decision) and src/lib/db-target.ts (the
// app-side check). Node's URL parser returns the IPv6 loopback hostname
// bracketed ("[::1]"), so both forms are listed.
export const LOOPBACK_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate that SUPABASE_POSTGRES_URL points at a loopback PostgreSQL
 * database — the target the concurrency audit's tsx snippets use via
 * src/lib/db. Required explicitly; accepts only the postgres:/postgresql:
 * protocols with a loopback hostname. Rejects remote hosts, including
 * every Supabase project and pooler host, and any query string or fragment
 * (a ?host= parameter could override the parsed host). Never echoes the
 * URL value: it carries credentials. Only the rejected hostname is named.
 */
export function checkLocalPostgresTarget(env = process.env) {
  if (env.NODE_ENV === "production") {
    return {
      status: "refused",
      reason: "NODE_ENV is production; destructive database operations are never allowed in production.",
    };
  }
  const raw = env[POSTGRES_URL_ENV];
  if (!raw) {
    return {
      status: "refused",
      reason: "SUPABASE_POSTGRES_URL is not set; refusing to guess a database target.",
    };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return {
      status: "refused",
      reason: "SUPABASE_POSTGRES_URL is not a valid URL.",
    };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    const scheme = raw.split(":")[0] || "(none)";
    return {
      status: "refused",
      reason: `SUPABASE_POSTGRES_URL must be a PostgreSQL URL; got scheme "${scheme}".`,
    };
  }
  if (!LOOPBACK_DB_HOSTS.has(url.hostname)) {
    return {
      status: "refused",
      reason: `SUPABASE_POSTGRES_URL must point at a loopback database (localhost, 127.0.0.1 or ::1); got host "${url.hostname}". Remote databases — including Supabase project and pooler hosts — are never valid targets for this audit.`,
    };
  }
  if (url.search !== "" || url.hash !== "") {
    return {
      status: "refused",
      reason: "SUPABASE_POSTGRES_URL must not have a query string or fragment (connection parameters could override the loopback host).",
    };
  }
  return { status: "ok", host: url.hostname };
}

const APP_DB_TARGET_PATH = "/api/db-target";
const APP_DB_TARGET_TIMEOUT_MS = 5_000;

/**
 * Verify the app at `base` is connected to a loopback database, via its
 * GET /api/db-target endpoint — which reports only a boolean, never
 * credentials, a hostname, or any connection detail. This is the one
 * network check in this module: a localhost base URL says nothing about
 * which database the app itself uses (it may have been started against
 * production Supabase), so the app must confirm its own target before this
 * script creates any rows. Refuses when the app cannot be reached, does
 * not answer, answers anything other than { databaseIsLoopback: true },
 * or reports a remote database.
 */
export async function verifyAppDatabaseTarget(base) {
  let response;
  try {
    response = await fetch(`${base}${APP_DB_TARGET_PATH}`, {
      signal: AbortSignal.timeout(APP_DB_TARGET_TIMEOUT_MS),
    });
  } catch {
    return {
      status: "refused",
      reason: `could not reach the app at ${base} to verify its database target (is the dev server running?); refusing because the database target cannot be verified.`,
    };
  }
  if (!response.ok) {
    return {
      status: "refused",
      reason: `the app at ${base} did not report its database target (HTTP ${response.status}); refusing because the database target cannot be verified.`,
    };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return {
      status: "refused",
      reason: `the app at ${base} returned an unreadable database-target response; refusing because the database target cannot be verified.`,
    };
  }
  if (body?.databaseIsLoopback !== true) {
    return {
      status: "refused",
      reason: `the app at ${base} is not connected to a loopback database; refusing because the audit would create orders in a remote database.`,
    };
  }
  return { status: "ok" };
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
