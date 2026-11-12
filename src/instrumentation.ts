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
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.PAYMENT_MAINTENANCE_WORKER === "off") return;
  try {
    const { startPaymentMaintenanceWorker } = await import("@/services/payment-maintenance-worker.service");
    startPaymentMaintenanceWorker();
  } catch (error) {
    // Server startup must never depend on the worker; the next sweep would retry.
    console.warn("[instrumentation] payment maintenance worker failed to start", error instanceof Error ? error.name : "");
  }
}
