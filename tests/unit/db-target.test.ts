// Unit tests for the app-side loopback database-target check (PR-07).
// Same rules as scripts/db-target-guards.mjs checkLocalPostgresTarget, kept
// in sync by test: only a PostgreSQL URL whose host is loopback, with no
// query string or fragment, counts as loopback.
import { describe, expect, it } from "vitest";
import { isLoopbackDbHostname, isLoopbackPostgresUrl } from "@/lib/db-target";

describe("isLoopbackPostgresUrl", () => {
  it("accepts loopback PostgreSQL URLs", () => {
    for (const url of [
      "postgresql://postgres:secret@localhost:5432/postgres",
      "postgres://postgres:secret@127.0.0.1:5432/postgres",
      "postgresql://postgres:secret@[::1]:5432/postgres",
      "postgresql://postgres:secret@localhost/postgres",
    ]) {
      expect(isLoopbackPostgresUrl(url)).toBe(true);
    }
  });

  it("rejects remote hosts, including Supabase project and pooler hosts", () => {
    for (const url of [
      "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
      "postgresql://postgres:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      "postgresql://postgres:secret@db.example.com:5432/postgres",
      "postgresql://postgres:secret@192.168.1.10:5432/postgres",
    ]) {
      expect(isLoopbackPostgresUrl(url)).toBe(false);
    }
  });

  it("rejects a query string or fragment (parameters could override the host)", () => {
    expect(
      isLoopbackPostgresUrl(
        "postgresql://postgres:secret@localhost:5432/postgres?host=db.example.supabase.co",
      ),
    ).toBe(false);
    expect(
      isLoopbackPostgresUrl("postgresql://postgres:secret@localhost:5432/postgres?sslmode=require"),
    ).toBe(false);
    expect(
      isLoopbackPostgresUrl("postgresql://postgres:secret@localhost:5432/postgres#frag"),
    ).toBe(false);
  });

  it("rejects missing, malformed, non-PostgreSQL, and hostless values", () => {
    expect(isLoopbackPostgresUrl(undefined)).toBe(false);
    expect(isLoopbackPostgresUrl("")).toBe(false);
    expect(isLoopbackPostgresUrl("postgresql://[::1")).toBe(false);
    expect(isLoopbackPostgresUrl("file:/tmp/x.db")).toBe(false);
    expect(isLoopbackPostgresUrl("mysql://root@localhost/db")).toBe(false);
    expect(isLoopbackPostgresUrl("postgresql:///mydb")).toBe(false);
  });
});

describe("isLoopbackDbHostname", () => {
  it("accepts the loopback host set (same as src/lib/db.ts)", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(isLoopbackDbHostname(host)).toBe(true);
    }
    for (const host of ["db.example.supabase.co", "", "0.0.0.0"]) {
      expect(isLoopbackDbHostname(host)).toBe(false);
    }
  });
});
