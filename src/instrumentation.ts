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
// This hook also registers the process-level error capture: unhandled promise
// rejections and uncaught exceptions are reported through the centralized
// error monitoring (src/lib/error-monitoring.ts) instead of only appearing
// as bare process output. An uncaught exception still exits the process
// after capture — the default Node.js behaviour — because the process is in
// an unknown state; a rejection is captured without exiting, matching the
// previous behaviour.
import { captureError } from "@/lib/error-monitoring";

let processHandlersRegistered = false;

function registerProcessErrorHandlers() {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;
  process.on("unhandledRejection", (reason) => {
    captureError(reason, { operation: "process-unhandled-rejection" });
  });
  process.on("uncaughtException", (error) => {
    captureError(error, { operation: "process-uncaught-exception" });
    process.exit(1);
  });
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  registerProcessErrorHandlers();
  if (process.env.PAYMENT_MAINTENANCE_WORKER === "off") return;
  try {
    const { startPaymentMaintenanceWorker } = await import("@/services/payment-maintenance-worker.service");
    startPaymentMaintenanceWorker();
  } catch (error) {
    // Server startup must never depend on the worker; the next sweep would retry.
    captureError(error, { operation: "payment-maintenance-worker-start" });
  }
}
