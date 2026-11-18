// Unit tests for the fail-closed database-target guards (PR-07, O-03).
// The guards are pure functions over env/argv, so these tests exercise the
// exact code the destructive scripts use — no database, no subprocess.
import { describe, expect, it } from "vitest";
import {
  checkDestructiveOptIn,
  checkLocalBaseUrl,
  checkLocalSqliteTarget,
  resolveFileUrlPath,
  resolveRunMode,
} from "../../scripts/db-target-guards.mjs";

// The guards take a full process env (like src/lib/seed-guards.ts); tests
// build one from a non-production base and override per case.
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

describe("checkLocalSqliteTarget", () => {
  it("refuses production even for a local file", () => {
    expect(
      checkLocalSqliteTarget(
        env({ NODE_ENV: "production", DATABASE_URL: "file:/tmp/dev.db" }),
      ),
    ).toEqual({
      status: "refused",
      reason: expect.stringContaining("production"),
    });
  });

  it("refuses a missing DATABASE_URL instead of guessing a target", () => {
    expect(checkLocalSqliteTarget(env())).toEqual({
      status: "refused",
      reason: expect.stringContaining("DATABASE_URL is not set"),
    });
  });

  it("refuses a PostgreSQL URL", () => {
    expect(
      checkLocalSqliteTarget(
        env({
          DATABASE_URL: "postgresql://postgres:secret@db.example.supabase.co:5432/postgres",
        }),
      ),
    ).toEqual({
      status: "refused",
      reason: expect.stringContaining('scheme "postgresql"'),
    });
  });

  it("refuses a postgres:// URL and any other non-file scheme", () => {
    for (const url of [
      "postgres://postgres:secret@localhost:5432/postgres",
      "https://example.com/db",
      "mysql://root@localhost/db",
    ]) {
      expect(checkLocalSqliteTarget(env({ DATABASE_URL: url })).status).toBe("refused");
    }
  });

  it("refuses a file: URL with an empty path", () => {
    expect(checkLocalSqliteTarget(env({ DATABASE_URL: "file:" })).status).toBe("refused");
  });

  it("accepts an absolute local file URL", () => {
    expect(
      checkLocalSqliteTarget(env({ DATABASE_URL: "file:/tmp/khareedo-test.sqlite" })),
    ).toEqual({ status: "ok", databasePath: "/tmp/khareedo-test.sqlite" });
  });

  it("accepts a repo-relative file URL", () => {
    const result = checkLocalSqliteTarget(env({ DATABASE_URL: "file:./dev.db" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.databasePath.endsWith("/dev.db")).toBe(true);
    }
  });

  it("accepts a disposable test database path", () => {
    expect(
      checkLocalSqliteTarget(
        env({
          DATABASE_URL: "file:/tmp/khareedo-sqlite-test-abc123/khareedo-test.sqlite",
        }),
      ),
    ).toEqual({
      status: "ok",
      databasePath: "/tmp/khareedo-sqlite-test-abc123/khareedo-test.sqlite",
    });
  });
});

describe("resolveFileUrlPath", () => {
  it("resolves absolute file URLs", () => {
    expect(resolveFileUrlPath("file:/tmp/x.db")).toBe("/tmp/x.db");
  });

  it("resolves repo-relative file URLs against the working directory", () => {
    expect(resolveFileUrlPath("file:./dev.db").endsWith("/dev.db")).toBe(true);
    expect(resolveFileUrlPath("file:dev.db").endsWith("/dev.db")).toBe(true);
  });
});

describe("checkDestructiveOptIn", () => {
  it("refuses when the opt-in is missing", () => {
    expect(checkDestructiveOptIn(env())).toEqual({
      status: "refused",
      reason: expect.stringContaining("DB_DESTRUCTIVE_ALLOW=1"),
    });
  });

  it("refuses near-miss values", () => {
    for (const value of ["true", "yes", "0", "01", " 1"]) {
      expect(checkDestructiveOptIn(env({ DB_DESTRUCTIVE_ALLOW: value })).status).toBe(
        "refused",
      );
    }
  });

  it("accepts exactly 1", () => {
    expect(checkDestructiveOptIn(env({ DB_DESTRUCTIVE_ALLOW: "1" }))).toEqual({
      status: "ok",
    });
  });
});

describe("resolveRunMode", () => {
  it("defaults to dry-run", () => {
    expect(resolveRunMode([])).toEqual({ status: "ok", mode: "dry-run" });
  });

  it("--apply selects apply mode", () => {
    expect(resolveRunMode(["--apply"])).toEqual({ status: "ok", mode: "apply" });
  });

  it("--dry-run selects dry-run mode", () => {
    expect(resolveRunMode(["--dry-run"])).toEqual({ status: "ok", mode: "dry-run" });
  });

  it("refuses --apply together with --dry-run", () => {
    expect(resolveRunMode(["--apply", "--dry-run"])).toEqual({
      status: "refused",
      reason: expect.stringContaining("either --apply or --dry-run"),
    });
  });
});

describe("checkLocalBaseUrl", () => {
  it("accepts localhost and 127.0.0.1 over http", () => {
    expect(checkLocalBaseUrl("http://localhost:3000")).toEqual({
      status: "ok",
      baseUrl: "http://localhost:3000",
    });
    expect(checkLocalBaseUrl("http://127.0.0.1:3000").status).toBe("ok");
  });

  it("refuses remote hosts, https, and unparseable values", () => {
    for (const base of [
      "https://localhost:3000",
      "http://example.com",
      "http://192.168.1.10:3000",
      "http://khareedo.example.com:3000",
      "not-a-url",
    ]) {
      expect(checkLocalBaseUrl(base).status).toBe("refused");
    }
  });
});
