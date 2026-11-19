import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// db.ts creates a PrismaClient at import time, so the generated client is
// mocked (same pattern as performance-timing.test.ts) and the module is
// imported dynamically after stubbing env vars per test.
vi.mock("../../generated/postgres-client", () => ({
  PrismaClient: class {
    constructor(_options: unknown) {}
    $extends(extension: unknown) {
      return this;
    }
  },
}));

const POOLER_URL =
  "postgresql://postgres.evsxjmtireufyymgsehx:secret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres";
const DIRECT_URL =
  "postgresql://postgres:secret@db.evsxjmtireufyymgsehx.supabase.co:5432/postgres";
const LOOPBACK_URL = "postgresql://postgres:secret@localhost:5432/postgres";
const OTHER_REMOTE_URL = "postgresql://postgres:secret@db.example.com:5432/postgres";

describe("postgresConnectionUrl (src/lib/db.ts)", () => {
  let caDir: string;
  let caPath: string;

  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as { prisma?: unknown }).prisma;
    caDir = mkdtempSync(join(tmpdir(), "khareedo-ca-"));
    caPath = join(caDir, "supabase-ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(caDir, { recursive: true, force: true });
  });

  it("fails fast with a clear error for a Supabase pooler host without a CA cert", async () => {
    vi.stubEnv("SUPABASE_POSTGRES_URL", POOLER_URL);
    vi.stubEnv("SUPABASE_DB_CA_CERT", "");
    await expect(import("@/lib/db")).rejects.toThrow(/SUPABASE_DB_CA_CERT is required/);
  });

  it("fails fast with a clear error for a direct Supabase host without a CA cert", async () => {
    vi.stubEnv("SUPABASE_POSTGRES_URL", DIRECT_URL);
    vi.stubEnv("SUPABASE_DB_CA_CERT", "");
    await expect(import("@/lib/db")).rejects.toThrow(/SUPABASE_DB_CA_CERT is required/);
  });

  it("accepts a Supabase pooler host with a CA cert and pins sslrootcert + verify-full", async () => {
    vi.stubEnv("SUPABASE_POSTGRES_URL", POOLER_URL);
    vi.stubEnv("SUPABASE_DB_CA_CERT", caPath);
    const { postgresConnectionUrl } = await import("@/lib/db");
    const url = new URL(postgresConnectionUrl());
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.get("sslrootcert")).toBe(caPath);
    expect(url.searchParams.get("connection_limit")).toBe("3");
  });

  it("does not require a CA cert for a loopback database", async () => {
    vi.stubEnv("SUPABASE_POSTGRES_URL", LOOPBACK_URL);
    vi.stubEnv("SUPABASE_DB_CA_CERT", "");
    const { postgresConnectionUrl } = await import("@/lib/db");
    const url = new URL(postgresConnectionUrl());
    expect(url.searchParams.get("sslmode")).toBe("disable");
    expect(url.searchParams.has("sslrootcert")).toBe(false);
  });

  it("does not require a CA cert for a non-Supabase remote host", async () => {
    vi.stubEnv("SUPABASE_POSTGRES_URL", OTHER_REMOTE_URL);
    vi.stubEnv("SUPABASE_DB_CA_CERT", "");
    const { postgresConnectionUrl } = await import("@/lib/db");
    const url = new URL(postgresConnectionUrl());
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.has("sslrootcert")).toBe(false);
  });

  it("requires SUPABASE_POSTGRES_URL", async () => {
    vi.stubEnv("SUPABASE_POSTGRES_URL", "");
    vi.stubEnv("SUPABASE_DB_CA_CERT", "");
    await expect(import("@/lib/db")).rejects.toThrow(/SUPABASE_POSTGRES_URL is required/);
  });
});
