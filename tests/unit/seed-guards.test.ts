// Unit tests for the seed guards (src/lib/seed-guards.ts).
import { describe, expect, it } from "vitest";
import {
  SEED_PASSWORD_DENYLIST,
  checkSeedTarget,
  validateSeedPassword,
} from "@/lib/seed-guards";

function env(overrides: Record<string, string | undefined> = {}) {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    SEED_ALLOW: "1",
    DATABASE_URL: "file:/tmp/khareedo-test.db",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

describe("checkSeedTarget", () => {
  it("allows an explicit opt-in against a local SQLite file", () => {
    expect(checkSeedTarget(env())).toEqual({ ok: true });
  });

  it("refuses when the opt-in is missing", () => {
    const result = checkSeedTarget(env({ SEED_ALLOW: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SEED_ALLOW=1/);
  });

  it("refuses opt-in values other than exactly '1'", () => {
    for (const value of ["yes", "true", "0", ""]) {
      const result = checkSeedTarget(env({ SEED_ALLOW: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/SEED_ALLOW=1/);
    }
  });

  it("refuses in production", () => {
    const result = checkSeedTarget(env({ NODE_ENV: "production" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/production/i);
  });

  it("refuses a missing DATABASE_URL (ambiguous target)", () => {
    const result = checkSeedTarget(env({ DATABASE_URL: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/DATABASE_URL/);
  });

  it("refuses a non-file DATABASE_URL", () => {
    for (const url of [
      "postgresql://postgres:postgres@localhost:5432/postgres",
      "postgres://db.example.supabase.co:5432/postgres",
      "dev.db",
    ]) {
      const result = checkSeedTarget(env({ DATABASE_URL: url }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/file:/);
    }
  });
});

describe("validateSeedPassword", () => {
  it("reports a missing password so the caller skips the account", () => {
    expect(validateSeedPassword(undefined, "SEED_ADMIN_PASSWORD")).toEqual({
      status: "missing",
      reason: expect.stringContaining("SEED_ADMIN_PASSWORD"),
    });
    expect(validateSeedPassword("", "SEED_ADMIN_PASSWORD").status).toBe("missing");
  });

  it("accepts a strong password", () => {
    expect(validateSeedPassword("CorrectHorseBatteryStaple1", "SEED_ADMIN_PASSWORD")).toEqual({
      status: "ok",
    });
  });

  it("accepts a 12-character password and rejects an 11-character one", () => {
    expect(validateSeedPassword("Abcdefgh123!", "SEED_ADMIN_PASSWORD")).toEqual({
      status: "ok",
    });
    expect(validateSeedPassword("Abcdefgh12!", "SEED_ADMIN_PASSWORD").status).toBe("invalid");
  });

  it("rejects a password longer than 72 characters", () => {
    expect(validateSeedPassword("A".repeat(73), "SEED_ADMIN_PASSWORD").status).toBe("invalid");
    expect(validateSeedPassword("A".repeat(72), "SEED_ADMIN_PASSWORD")).toEqual({
      status: "ok",
    });
  });

  it("rejects the previously published demo passwords", () => {
    expect(SEED_PASSWORD_DENYLIST).toContain("admin@123");
    expect(SEED_PASSWORD_DENYLIST).toContain("customer@123");
    // The published values are short, so they fail the length rule first —
    // they are invalid either way. A 12-character variant reaches the
    // denylist rule and must be refused for that reason.
    for (const password of ["Admin@123", "Customer@123", "ADMIN@123", "customer@123"]) {
      expect(validateSeedPassword(password, "SEED_ADMIN_PASSWORD").status).toBe("invalid");
    }
    const result = validateSeedPassword("Admin@123456", "SEED_ADMIN_PASSWORD");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toMatch(/published demo password/);
    }
  });

  it("rejects a published demo password even as a substring", () => {
    expect(validateSeedPassword("Customer@123!", "SEED_CUSTOMER_PASSWORD").status).toBe(
      "invalid",
    );
    expect(validateSeedPassword("xxAdmin@123xx", "SEED_ADMIN_PASSWORD").status).toBe("invalid");
  });

  it("rejects other common defaults case-insensitively", () => {
    for (const password of ["Password1234", "PASSWORD123", "changeme12345", "QWERTY123456"]) {
      expect(validateSeedPassword(password, "SEED_ADMIN_PASSWORD").status).toBe("invalid");
    }
  });
});
