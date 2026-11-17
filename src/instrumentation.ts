// Next.js instrumentation hook — runs once per server process start (dev and
// standalone production server, Node.js runtime only). It starts the in-process
// payment maintenance worker so that reservation expiry, webhook-inbox processing and
// provider reconciliation actually execute on a schedule. Previously these bounded
// sweeps existed only behind the admin maintenance endpoint and nothing ever invoked
// them, which left successfully paid checkouts PENDING whenever Safepay could not
// deliver a webhook (e.g. any non-public origin).
//
// Set PAYMENT_MAINTENANCE_WORKER=off to disable (recommended for serverless deploys,
// where an external cron should call POST /api/admin/payments/maintenance instead).
//
// This hook also registers process-level error capture through
// `uncaughtExceptionMonitor` (src/lib/error-monitoring.ts). A monitor
// listener only observes: it does not change Node.js default behaviour.
// - An uncaught exception is captured and the process still terminates with
//   a non-zero exit code, exactly as it would with no listener at all.
// - An unhandled promise rejection escalates to an uncaught exception under
//   Node.js's default `--unhandled-rejections=throw` mode, so it is captured
//   by the same monitor and the process still exits non-zero.
// Deliberately NOT used: `process.on("unhandledRejection", …)` would
// suppress that escalation and let the app keep running in an unsafe state,
// and `process.on("uncaughtException", …)` would replace the default
// termination behaviour. This hook never swallows, recovers from, or changes
// the exit behaviour of an uncaught exception.
import { captureError } from "@/lib/error-monitoring";

let processMonitorRegistered = false;

function registerProcessErrorMonitor() {
  if (processMonitorRegistered) return;
  processMonitorRegistered = true;
  process.on("uncaughtExceptionMonitor", (error) => {
    captureError(error, { operation: "process-uncaught-exception" });
  });
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  registerProcessErrorMonitor();
  if (process.env.PAYMENT_MAINTENANCE_WORKER === "off") return;
  try {
    const { startPaymentMaintenanceWorker } = await import("@/services/payment-maintenance-worker.service");
    startPaymentMaintenanceWorker();
  } catch (error) {
    // Server startup must never depend on the worker; the next sweep would retry.
    captureError(error, { operation: "payment-maintenance-worker-start" });
  }
}
