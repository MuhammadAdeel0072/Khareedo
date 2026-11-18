// Subprocess tests for the audit-concurrency database-target guard (PR-07 fix).
// The guard runs at the top of the script, so a refused environment exits 1
// before the script touches any app or database. There is no valid-path test
// here: a passing guard would run the live audit against a running app,
// which this sandbox does not have.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "audit-concurrency.mjs");

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
  it("refuses a missing DATABASE_URL", () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });

  it("refuses a PostgreSQL DATABASE_URL", () => {
    const result = run({
      DATABASE_URL: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scheme "postgresql"');
  });

  it("refuses production even with a local file target", () => {
    const result = run({
      DATABASE_URL: "file:/tmp/khareedo-audit-test.db",
      NODE_ENV: "production",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production");
  });

  it("refuses a non-localhost base even with a valid DATABASE_URL", () => {
    const result = run({
      DATABASE_URL: "file:/tmp/khareedo-audit-test.db",
      BASE: "https://example.com",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local development app");
  });
});
