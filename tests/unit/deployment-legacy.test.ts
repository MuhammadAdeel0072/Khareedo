// Static repo-hygiene tests for the deployment legacy cleanup.
// No database, no server: these read the repo files as text and lock the
// cleanup in place so stale deployment artifacts cannot return silently.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("deployment legacy cleanup", () => {
  it("stale project-structure and empty audit files are gone", () => {
    expect(existsSync(join(repoRoot, "project-structure.txt"))).toBe(false);
    expect(existsSync(join(repoRoot, "project-audit.txt"))).toBe(false);
  });

  it("dead platform runtime-builder tests are gone", () => {
    for (const file of [
      "tests/database-runtime-build.sh",
      "tests/python-runtime-build.sh",
      "tests/python-runtime-container.sh",
    ]) {
      expect(existsSync(join(repoRoot, file))).toBe(false);
    }
    // The builder they tested is not in the repo either.
    expect(existsSync(join(repoRoot, ".zscripts"))).toBe(false);
  });

  it(".env.example matches the variables the app actually reads", () => {
    const example = read(".env.example");
    // Never read anywhere (the browser never talks to Supabase directly;
    // Storage uses the server-side service-role key).
    expect(example).not.toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    // Read by src/lib/performance-timing.ts and documented in the README.
    expect(example).toContain("LOG_LEVEL");
  });

  it("the README carries no reference to the deleted lockfile", () => {
    expect(read("README.md")).not.toContain("bun.lock");
  });

  it("the deployment doc records the Caddyfile's unverified status", () => {
    const deployment = read("docs/DEPLOYMENT.md");
    expect(deployment).toContain("Caddyfile");
    expect(deployment).toContain("Nothing in the repo establishes");
  });
});
