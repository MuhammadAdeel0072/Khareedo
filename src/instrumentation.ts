// Next.js instrumentation hook — runs once per server process start (dev and
// standalone production server, Node.js runtime only). It starts the in-process
// payment maintenance worker so that reservation expiry, webhook-inbox processing and
// provider reconciliation actually execute on a schedule. Previously these bounded
// sweeps existed only behind the admin maintenance endpoint and nothing ever invoked
// them, which left successfully paid checkouts PENDING whenever Safepay could not
// deliver a webhook (e.g. any non-public origin).
//
// It also starts the email outbox worker (PR-09), which delivers password
// reset emails enqueued by the forgot-password endpoint.
//
// Each worker has its OWN opt-out, and they are independent: disabling one
// must never silently disable the other.
// - Set PAYMENT_MAINTENANCE_WORKER=off to disable the payment worker
//   (recommended for serverless deploys, where an external cron should call
//   POST /api/admin/payments/maintenance instead).
// - Set EMAIL_OUTBOX_WORKER=off to disable the email outbox worker (for
//   serverless deploys, where an external scheduler should call
//   deliverPendingOutboxEmails instead).
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
//
// The monitor registration lives in src/instrumentation-node.ts and is
// imported dynamically below, only in the Node.js runtime. The Edge Runtime
// compiler statically flags `process.on` as unsupported even behind a
// runtime guard, so it must not appear in this file.
import { captureError } from "@/lib/error-monitoring";
import { warnTrustedProxyStartup } from "@/lib/trusted-proxy";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { registerProcessErrorMonitor } = await import("@/instrumentation-node");
  registerProcessErrorMonitor();

  // Production trusted-proxy warning: log only, never throws. When
  // TRUSTED_PROXY_IPS is unset, every per-IP rate limit collapses to one
  // global bucket — operators must see this at boot, not discover it
  // from a lockout. Also evaluated lazily on first trusted-proxy use.
  warnTrustedProxyStartup();

  // Payment maintenance worker. Its opt-out (PAYMENT_MAINTENANCE_WORKER=off)
  // guards ONLY this worker: it must never prevent the email outbox worker
  // below from starting.
  if (process.env.PAYMENT_MAINTENANCE_WORKER !== "off") {
    try {
      const { startPaymentMaintenanceWorker } = await import("@/services/payment-maintenance-worker.service");
      startPaymentMaintenanceWorker();
    } catch (error) {
      // Server startup must never depend on the worker; the next sweep would retry.
      captureError(error, { operation: "payment-maintenance-worker-start" });
    }
  }

  // Email outbox worker (PR-09): delivers password reset emails enqueued by
  // the forgot-password endpoint. It has its OWN opt-out,
  // EMAIL_OUTBOX_WORKER=off — disabling payment maintenance does not disable
  // it. Server startup must never depend on it.
  if (process.env.EMAIL_OUTBOX_WORKER !== "off") {
    try {
      const { startEmailOutboxWorker } = await import("@/services/email-outbox.service");
      startEmailOutboxWorker();
    } catch (error) {
      captureError(error, { operation: "email-outbox-worker-start" });
    }
  }
}
