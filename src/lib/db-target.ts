// Loopback database-target check (PR-07).
//
// The concurrency audit must prove the app it talks to is connected to a
// local database before creating any rows. This helper answers that
// question from the connection string alone: true only for a PostgreSQL URL
// whose host is loopback, with no query string or fragment (a ?host=
// parameter could override the parsed host). It never connects to the
// database and never exposes any part of the URL — the caller reports only
// the boolean.
//
// The loopback host set matches src/lib/db.ts (which uses the same set for
// its sslmode decision) and scripts/db-target-guards.mjs (which enforces
// the same rule for the script's own SUPABASE_POSTGRES_URL). Node's URL
// parser returns the IPv6 loopback hostname bracketed ("[::1]"), so both
// forms are listed.
export const LOOPBACK_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackDbHostname(hostname: string): boolean {
  return LOOPBACK_DB_HOSTS.has(hostname);
}

/** True only when `raw` is a PostgreSQL URL whose host is loopback. */
export function isLoopbackPostgresUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return isLoopbackDbHostname(url.hostname);
}
