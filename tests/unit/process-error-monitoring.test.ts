import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Process-level error monitoring is verified in a real child process running
// plain Node.js — not inside Vitest — so the assertions observe Node.js
// default behaviour: the `uncaughtExceptionMonitor` listener must capture the
// error while the process still exits non-zero, exactly as it would with no
// listener at all.
//
// The child runs the TypeScript harness directly (Node 24 type stripping)
// with the alias hook from tests/helpers, so it exercises the real
// src/instrumentation.ts and src/lib/error-monitoring.ts.
const repoRoot = process.cwd();
const hookPath = path.join(repoRoot, "tests/helpers/register-ts-alias.mjs");
const harnessPath = path.join(repoRoot, "tests/helpers/process-error-harness.ts");

function runHarness(scenario: "unhandled-rejection" | "uncaught-exception") {
  return spawnSync(process.execPath, ["--import", hookPath, harnessPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PROCESS_ERROR_SCENARIO: scenario,
      SUPABASE_POSTGRES_URL: "postgresql://postgres:postgres@localhost:5432/postgres",
      DATABASE_URL: "file:./dev.db",
    },
  });
}

function assertCapturedAndCrashed(
  result: ReturnType<typeof runHarness>,
  expectedMessage: string,
) {
  const stderr = result.stderr ?? "";
  // The monitor captured the error as a structured log line before termination.
  expect(stderr).toContain('"type":"error"');
  expect(stderr).toContain('"operation":"process-uncaught-exception"');
  expect(stderr).toContain(expectedMessage);
  // The harness exits 2 if it survived the error or was misconfigured;
  // Node's default uncaught-exception exit code is 1.
  expect(result.status).toBe(1);
  expect(stderr).not.toContain("process survived");
}

describe("process-level error monitoring (child process)", () => {
  it("captures an unhandled rejection and still exits non-zero", async () => {
    const result = runHarness("unhandled-rejection");
    assertCapturedAndCrashed(result, "harness unhandled rejection");
  }, 60_000);

  it("captures an uncaught synchronous exception and still terminates", async () => {
    const result = runHarness("uncaught-exception");
    assertCapturedAndCrashed(result, "harness uncaught exception");
  }, 60_000);
});
