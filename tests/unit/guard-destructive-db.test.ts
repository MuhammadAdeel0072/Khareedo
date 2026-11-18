// Subprocess tests for the destructive-Prisma guard wrapper (PR-07, O-03).
// The wrapper is exercised as a real CLI: refusal cases must exit 1 without
// spawning Prisma, and --dry-run must exit 0 without touching any database
// file. No test here runs Prisma or opens a database.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const wrapper = join(repoRoot, "scripts", "guard-destructive-db.mjs");

function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    encoding: "utf8",
  });
}

describe("guard-destructive-db wrapper", () => {
  it("refuses with no command", () => {
    const result = run([], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });

  it("refuses an unknown command", () => {
    const result = run(["explode"], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command");
  });

  it("refuses without the opt-in even for a local file target", () => {
    const result = run(["push"], { DATABASE_URL: "file:/tmp/khareedo-guard-test.db" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DB_DESTRUCTIVE_ALLOW=1");
    expect(existsSync("/tmp/khareedo-guard-test.db")).toBe(false);
  });

  it("refuses a PostgreSQL target even with the opt-in", () => {
    const result = run(["push"], {
      DATABASE_URL: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres",
      DB_DESTRUCTIVE_ALLOW: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scheme "postgresql"');
  });

  it("refuses a missing DATABASE_URL even with the opt-in", () => {
    const result = run(["reset"], { DB_DESTRUCTIVE_ALLOW: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });

  it("refuses production even with the opt-in and a local file", () => {
    const result = run(["push"], {
      DATABASE_URL: "file:/tmp/khareedo-guard-test.db",
      DB_DESTRUCTIVE_ALLOW: "1",
      NODE_ENV: "production",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production");
    expect(existsSync("/tmp/khareedo-guard-test.db")).toBe(false);
  });

  it("dry-run prints the exact command and target and touches nothing", () => {
    const target = "/tmp/khareedo-guard-dry-run.db";
    const result = run(["push", "--dry-run"], {
      DATABASE_URL: `file:${target}`,
      DB_DESTRUCTIVE_ALLOW: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prisma db push --accept-data-loss");
    expect(result.stdout).toContain(target);
    expect(result.stdout).toContain("dry-run: Prisma was not executed.");
    expect(existsSync(target)).toBe(false);
  });

  it("dry-run works for reset and migrate", () => {
    for (const [command, expected] of [
      ["reset", "prisma migrate reset"],
      ["migrate", "prisma migrate dev"],
    ] as const) {
      const result = run([command, "--dry-run"], {
        DATABASE_URL: "file:/tmp/khareedo-guard-dry-run.db",
        DB_DESTRUCTIVE_ALLOW: "1",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(expected);
    }
  });
});
