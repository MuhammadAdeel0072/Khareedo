// Static repo-hygiene tests for the Prisma schema + lockfile strategy (PR-08).
// No database, no Prisma CLI: these read the repo files as text and lock the
// strategy in place so drift cannot return silently.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
};

const SQLITE_SCHEMA = "prisma/schema.sqlite.prisma";
const POSTGRES_SCHEMA = "prisma/schema.postgres.prisma";

describe("lockfiles: npm only", () => {
  it("package-lock.json exists and no competing lockfile exists", () => {
    expect(existsSync(join(repoRoot, "package-lock.json"))).toBe(true);
    for (const lock of ["bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"]) {
      expect(existsSync(join(repoRoot, lock))).toBe(false);
    }
  });

  it("no package script installs with another package manager", () => {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, `script ${name}`).not.toMatch(/\bbun (install|add|update)\b/);
      expect(cmd, `script ${name}`).not.toMatch(/\bbunx\b/);
      expect(cmd, `script ${name}`).not.toMatch(/\byarn\b/);
      expect(cmd, `script ${name}`).not.toMatch(/\bpnpm\b/);
    }
  });

  it("the README offers no other package manager", () => {
    const readme = read("README.md");
    expect(readme).not.toContain("bun install");
    expect(readme).not.toContain("bunx");
  });

  it("the gitignore keeps competing lockfiles out of the tree", () => {
    const gitignore = read(".gitignore");
    for (const lock of ["bun.lock", "yarn.lock", "pnpm-lock.yaml"]) {
      expect(gitignore).toContain(lock);
    }
  });
});

describe("prisma schemas: one logical schema, two providers", () => {
  it("both schemas exist and no default prisma/schema.prisma exists", () => {
    expect(existsSync(join(repoRoot, SQLITE_SCHEMA))).toBe(true);
    expect(existsSync(join(repoRoot, POSTGRES_SCHEMA))).toBe(true);
    // No implicit default: a bare `prisma` command must fail instead of
    // silently targeting one of the schemas.
    expect(existsSync(join(repoRoot, "prisma/schema.prisma"))).toBe(false);
  });

  it("the schemas describe the same models, fields and indexes", () => {
    const normalize = (text: string) =>
      text
        .split("\n")
        .map((line) => {
          // Strip inline comments (a space followed by //). String defaults
          // never contain " //", so this cannot cut a value.
          const cut = line.indexOf(" //");
          return (cut === -1 ? line : line.slice(0, cut)).trim();
        })
        .filter((line) => line !== "" && !line.startsWith("//"))
        .map((line) => line.replace(/\s+/g, " "))
        // Allowlisted per-provider differences only.
        .filter((line) => !/^provider = "(sqlite|postgresql)"$/.test(line))
        .filter((line) => !/^output = "\.\.\/generated\/(sqlite|postgres)-client"$/.test(line))
        .filter((line) => !/^binaryTargets = /.test(line))
        .filter((line) => !/^previewFeatures = /.test(line));
    expect(normalize(read(SQLITE_SCHEMA))).toEqual(normalize(read(POSTGRES_SCHEMA)));
  });

  it("each schema generates its own client", () => {
    expect(read(SQLITE_SCHEMA)).toContain('output   = "../generated/sqlite-client"');
    expect(read(POSTGRES_SCHEMA)).toContain('output          = "../generated/postgres-client"');
    expect(read(SQLITE_SCHEMA)).toContain('provider = "sqlite"');
    expect(read(POSTGRES_SCHEMA)).toContain('provider = "postgresql"');
  });

  it("every prisma generate/push command names its schema explicitly", () => {
    expect(pkg.scripts["db:generate"]).toContain("--schema prisma/schema.sqlite.prisma");
    expect(pkg.scripts["db:generate:postgres"]).toContain(
      "--schema prisma/schema.postgres.prisma",
    );
    const harness = read("scripts/run-isolated-sqlite-tests.mjs");
    expect(harness).toContain('"prisma/schema.sqlite.prisma"');
    expect(harness).not.toContain('"prisma/schema.prisma"');
  });
});
