// Unit tests for the fail-closed database-target guards (PR-07, O-03).
// The guards are pure functions over env/argv, so these tests exercise the
// exact code the destructive scripts use — no database, no subprocess.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDestructiveOptIn,
  checkLocalBaseUrl,
  checkLocalPostgresTarget,
  checkLocalSqliteTarget,
  resolveFileUrlPath,
  resolveRunMode,
} from "../../scripts/db-target-guards.mjs";

// The guards take a full process env (like src/lib/seed-guards.ts); tests
// build one from a non-production base and override per case.
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

// Prisma resolves a relative SQLite file: URL against the Prisma schema
// directory (prisma/), not the working directory — verified 2026-11-19
// against both `prisma db push` and the generated Prisma Client.
const schemaDir = join(fileURLToPath(new URL("../..", import.meta.url)), "prisma");

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

  it("refuses a file: URL with a hostname/authority", () => {
    for (const url of ["file://server/share.db", "file://localhost/tmp/x.db"]) {
      const result = checkLocalSqliteTarget(env({ DATABASE_URL: url }));
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toContain("hostname/authority");
      }
    }
  });

  it("refuses a file: URL with a query string or fragment", () => {
    expect(
      checkLocalSqliteTarget(env({ DATABASE_URL: "file:/tmp/x.db?mode=ro" })),
    ).toEqual({
      status: "refused",
      reason: expect.stringContaining("query string"),
    });
    expect(
      checkLocalSqliteTarget(env({ DATABASE_URL: "file:/tmp/x.db#frag" })).status,
    ).toBe("refused");
  });

  it("accepts an absolute local file URL", () => {
    expect(
      checkLocalSqliteTarget(env({ DATABASE_URL: "file:/tmp/khareedo-test.sqlite" })),
    ).toEqual({ status: "ok", databasePath: "/tmp/khareedo-test.sqlite" });
    expect(
      checkLocalSqliteTarget(env({ DATABASE_URL: "file:///tmp/khareedo-test.sqlite" })),
    ).toEqual({ status: "ok", databasePath: "/tmp/khareedo-test.sqlite" });
  });

  it("resolves a repo-relative file URL against the Prisma schema directory", () => {
    const result = checkLocalSqliteTarget(env({ DATABASE_URL: "file:./dev.db" }));
    expect(result).toEqual({ status: "ok", databasePath: join(schemaDir, "dev.db") });
    // The old code resolved this to /dev.db (filesystem root) while Prisma
    // targets prisma/dev.db — the displayed target must be the real one.
    expect(result).not.toEqual({ status: "ok", databasePath: "/dev.db" });
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

describe("checkLocalPostgresTarget", () => {
  it("refuses production even for a loopback database", () => {
    expect(
      checkLocalPostgresTarget(
        env({
          NODE_ENV: "production",
          SUPABASE_POSTGRES_URL: "postgresql://postgres:secret@localhost:5432/postgres",
        }),
      ),
    ).toEqual({
      status: "refused",
      reason: expect.stringContaining("production"),
    });
  });

  it("refuses a missing SUPABASE_POSTGRES_URL instead of guessing a target", () => {
    expect(checkLocalPostgresTarget(env())).toEqual({
      status: "refused",
      reason: expect.stringContaining("SUPABASE_POSTGRES_URL is not set"),
    });
  });

  it("accepts loopback PostgreSQL URLs", () => {
    for (const url of [
      "postgresql://postgres:secret@localhost:5432/postgres",
      "postgres://postgres:secret@127.0.0.1:5432/postgres",
      "postgresql://postgres:secret@[::1]:5432/postgres",
      "postgresql://postgres:secret@localhost/postgres",
    ]) {
      const result = checkLocalPostgresTarget(env({ SUPABASE_POSTGRES_URL: url }));
      expect(result.status).toBe("ok");
    }
  });

  it("rejects remote hosts, including Supabase project and pooler hosts", () => {
    for (const url of [
      "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
      "postgresql://postgres:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      "postgresql://postgres:secret@db.example.com:5432/postgres",
      "postgresql://postgres:secret@192.168.1.10:5432/postgres",
    ]) {
      const result = checkLocalPostgresTarget(env({ SUPABASE_POSTGRES_URL: url }));
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toContain("loopback");
      }
    }
  });

  it("rejects non-PostgreSQL schemes", () => {
    for (const url of ["file:/tmp/x.db", "mysql://root@localhost/db"]) {
      expect(
        checkLocalPostgresTarget(env({ SUPABASE_POSTGRES_URL: url })).status,
      ).toBe("refused");
    }
  });

  it("rejects a query string or fragment (parameters could override the host)", () => {
    expect(
      checkLocalPostgresTarget(
        env({
          SUPABASE_POSTGRES_URL:
            "postgresql://postgres:secret@localhost:5432/postgres?host=db.example.supabase.co",
        }),
      ),
    ).toEqual({
      status: "refused",
      reason: expect.stringContaining("query string"),
    });
    expect(
      checkLocalPostgresTarget(
        env({
          SUPABASE_POSTGRES_URL: "postgresql://postgres:secret@localhost:5432/postgres#frag",
        }),
      ).status,
    ).toBe("refused");
  });

  it("refuses a malformed URL and a URL with no host, without echoing credentials", () => {
    const remote =
      "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";
    const result = checkLocalPostgresTarget(env({ SUPABASE_POSTGRES_URL: remote }));
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).not.toContain("secret");
      expect(result.reason).not.toContain("postgres://");
    }
    expect(
      checkLocalPostgresTarget(env({ SUPABASE_POSTGRES_URL: "postgresql://[::1" })).status,
    ).toBe("refused");
    expect(
      checkLocalPostgresTarget(env({ SUPABASE_POSTGRES_URL: "postgresql:///mydb" })).status,
    ).toBe("refused");
  });
});

describe("resolveFileUrlPath", () => {
  it("resolves absolute file URLs", () => {
    expect(resolveFileUrlPath("file:/tmp/x.db")).toEqual({
      status: "ok",
      path: "/tmp/x.db",
    });
    expect(resolveFileUrlPath("file:///tmp/x.db")).toEqual({
      status: "ok",
      path: "/tmp/x.db",
    });
  });

  it("resolves relative file URLs against the Prisma schema directory", () => {
    expect(resolveFileUrlPath("file:./dev.db")).toEqual({
      status: "ok",
      path: join(schemaDir, "dev.db"),
    });
    expect(resolveFileUrlPath("file:dev.db")).toEqual({
      status: "ok",
      path: join(schemaDir, "dev.db"),
    });
    expect(resolveFileUrlPath("file:./db/custom.db")).toEqual({
      status: "ok",
      path: join(schemaDir, "db", "custom.db"),
    });
  });

  it("decodes percent-encoding", () => {
    expect(resolveFileUrlPath("file:./x%20y.db")).toEqual({
      status: "ok",
      path: join(schemaDir, "x y.db"),
    });
  });

  it("refuses file URLs with a hostname/authority", () => {
    for (const url of ["file://server/share.db", "file://localhost/tmp/x.db"]) {
      const result = resolveFileUrlPath(url);
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toContain("hostname/authority");
      }
    }
  });

  it("refuses UNC-style network paths", () => {
    // file:////server/share.db has an empty authority and a // path.
    expect(resolveFileUrlPath("file:////server/share.db")).toEqual({
      status: "refused",
      reason: expect.stringContaining("network"),
    });
    // Backslashes are the Windows UNC form.
    expect(resolveFileUrlPath("file:///\\\\server\\share.db")).toEqual({
      status: "refused",
      reason: expect.stringContaining("backslashes"),
    });
  });

  it("refuses query strings and fragments", () => {
    expect(resolveFileUrlPath("file:/tmp/x.db?mode=ro")).toEqual({
      status: "refused",
      reason: expect.stringContaining("query string"),
    });
    expect(resolveFileUrlPath("file:/tmp/x.db#frag")).toEqual({
      status: "refused",
      reason: expect.stringContaining("fragment"),
    });
  });

  it("refuses malformed URLs", () => {
    expect(resolveFileUrlPath("file://[::1")).toEqual({
      status: "refused",
      reason: expect.stringContaining("not a valid URL"),
    });
    expect(resolveFileUrlPath("file:%")).toEqual({
      status: "refused",
      reason: expect.stringContaining("percent-encoding"),
    });
  });

  it("refuses URLs that do not name a file", () => {
    for (const url of ["file:", "file://", "file:///", "file:/tmp/x.db/"]) {
      expect(resolveFileUrlPath(url).status).toBe("refused");
    }
  });

  it("refuses non-file schemes without echoing the value", () => {
    const result = resolveFileUrlPath(
      "postgresql://postgres:secret@db.example.supabase.co:5432/postgres",
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toContain('scheme "postgresql"');
      expect(result.reason).not.toContain("secret");
    }
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
