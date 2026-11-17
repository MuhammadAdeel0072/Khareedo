// Child-process harness for process-level error monitoring tests.
//
// Runs under PLAIN Node.js (not Vitest) so the assertions observe Node.js
// default behaviour, not a test runner's: `node --import
// tests/helpers/register-ts-alias.mjs tests/helpers/process-error-harness.ts`
// with PROCESS_ERROR_SCENARIO set to one of:
//
// - "unhandled-rejection": reject a promise with no handler. Under Node's
//   default `--unhandled-rejections=throw` mode this escalates to an uncaught
//   exception, which the `uncaughtExceptionMonitor` listener must capture
//   before the process exits non-zero.
// - "uncaught-exception": throw synchronously. The monitor must capture it
//   and the process must still terminate with a non-zero exit code.
//
// Exit codes: 1 = crashed as expected (Node.js default); 2 = misconfigured
// run, or the process survived the error (the failure the monitor fix guards
// against). The maintenance worker is disabled here so the harness only
// exercises the error monitor, not the worker.
import { register } from "../../src/instrumentation";

const scenario = process.env.PROCESS_ERROR_SCENARIO;
if (scenario !== "unhandled-rejection" && scenario !== "uncaught-exception") {
  console.error(
    "process-error-harness: PROCESS_ERROR_SCENARIO must be unhandled-rejection or uncaught-exception",
  );
  process.exit(2);
}

process.env.NEXT_RUNTIME = "nodejs";
process.env.PAYMENT_MAINTENANCE_WORKER = "off";
await register();

if (scenario === "unhandled-rejection") {
  void Promise.reject(new Error("harness unhandled rejection"));
  // Give the default escalation a chance to fire. If the process is still
  // alive after this, the rejection was swallowed — fail loudly instead of
  // exiting 0.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  console.error("process-error-harness: process survived an unhandled rejection");
  process.exit(2);
} else {
  throw new Error("harness uncaught exception");
}
