// Subprocess tests for the audit-concurrency database-target guards (PR-07 fix).
// The guards run at the top of the script, so a refused environment exits 1
// before the script touches any app or database. There is no valid-path test
// here: a passing guard would run the live audit against a running app,
// which this sandbox does not have.
//
// The script's database operations go through src/lib/db (PostgreSQL), so
// the guarded variable is SUPABASE_POSTGRES_URL — not DATABASE_URL (SQLite),
// which this script never uses.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "audit-concurrency.mjs");
const LOCAL_POSTGRES = "postgresql://postgres:secret@localhost:5432/postgres";

function run(env: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      BASE: "http://localhost:3000",
      ...env,
    },
    encoding: "utf8",
    timeout: 30000,
  });
}

describe("audit-concurrency database-target guard", () => {
  it("refuses a missing SUPABASE_POSTGRES_URL", () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SUPABASE_POSTGRES_URL is not set");
  });

  it("refuses a remote Supabase project host", () => {
    const result = run({
      SUPABASE_POSTGRES_URL:
        "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("loopback");
  });

  it("refuses a Supabase pooler host", () => {
    const result = run({
      SUPABASE_POSTGRES_URL:
        "postgresql://postgres:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("loopback");
  });

  it("refuses production even with a loopback database", () => {
    const result = run({
      SUPABASE_POSTGRES_URL: LOCAL_POSTGRES,
      NODE_ENV: "production",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production");
  });

  it("refuses a non-localhost base even with a loopback database", () => {
    const result = run({
      SUPABASE_POSTGRES_URL: LOCAL_POSTGRES,
      BASE: "https://example.com",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local development app");
  });

  it("refuses when the app cannot be reached to verify its database", () => {
    // A loopback script target is not enough: the app at BASE must confirm
    // server-side that its own database is loopback. Nothing listens on
    // :3000 here, so the verification fails fast.
    const result = run({ SUPABASE_POSTGRES_URL: LOCAL_POSTGRES });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not reach");
    expect(result.stderr).toContain("cannot be verified");
  });
});
