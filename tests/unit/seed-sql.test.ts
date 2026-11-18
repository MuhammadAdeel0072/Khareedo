// Static guards for the Postgres demo seed (PR-06 fix).
//
// docs/legacy/supabase-migrations/seed.sql is a legacy, hand-maintained SQL file, and
// scripts/export-seed-sql.ts regenerates it from the live database. Both
// must agree: re-applying the seed must never overwrite existing rows, and
// the SQL seed must never provision accounts or carry password hashes.
// The exporter needs a live Postgres database to run, so these guards read
// the two files as text instead — the committed seed.sql is the artifact
// that actually gets applied, and the exporter templates are what would
// regenerate it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const seedSql = readFileSync(
  fileURLToPath(new URL("../../docs/legacy/supabase-migrations/seed.sql", import.meta.url)),
  "utf8",
);
const exporter = readFileSync(
  fileURLToPath(new URL("../../scripts/export-seed-sql.ts", import.meta.url)),
  "utf8",
);

function linesMatching(text: string, pattern: RegExp): string[] {
  return text.split("\n").filter((line) => pattern.test(line));
}

describe("SQL seed non-overwrite behaviour", () => {
  it("seed.sql never overwrites a row on conflict", () => {
    expect(seedSql).not.toMatch(/do update/i);
  });

  it("seed.sql settings inserts keep existing values", () => {
    const settings = linesMatching(seedSql, /insert into public\.store_settings/);
    expect(settings.length).toBe(18);
    for (const line of settings) {
      expect(line).toContain("on conflict (key) do nothing");
    }
  });

  it("seed.sql inventory inserts keep existing quantities", () => {
    const inventory = linesMatching(seedSql, /insert into public\.inventory/);
    expect(inventory.length).toBe(51);
    for (const line of inventory) {
      expect(line).toContain("on conflict (product_id) do nothing");
    }
  });

  it("seed.sql creates no accounts and carries no password hashes", () => {
    expect(seedSql).not.toMatch(/insert into public\.(profiles|users|user_profiles)/i);
    expect(seedSql).not.toMatch(/password_hash/i);
  });

  it("the exporter generates the same non-overwrite behaviour", () => {
    // The exporter templates are the source of the next seed.sql.
    expect(exporter).not.toMatch(/do update set/i);
    expect(exporter).toContain("on conflict (key) do nothing;");
    expect(exporter).toContain("on conflict (product_id) do nothing;");
    const settingsTemplate = linesMatching(exporter, /insert into public\.store_settings/);
    expect(settingsTemplate.length).toBe(1);
    expect(settingsTemplate[0]).toContain("on conflict (key) do nothing;");
    const inventoryTemplate = linesMatching(exporter, /insert into public\.inventory/);
    expect(inventoryTemplate.length).toBe(1);
    expect(inventoryTemplate[0]).toContain("on conflict (product_id) do nothing;");
  });

  it("the exporter still never exports accounts, hashes or addresses", () => {
    expect(exporter).not.toMatch(/passwordHash/i);
    expect(exporter).not.toMatch(/db\.user\.findMany/i);
    expect(exporter).not.toMatch(/db\.address\.findMany/i);
  });
});
