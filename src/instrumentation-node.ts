// Node.js-only process error monitor.
//
// Kept in its own module and imported dynamically from src/instrumentation.ts
// ONLY when NEXT_RUNTIME === "nodejs". The Edge Runtime compiler statically
// flags `process.on` as unsupported even when the call is guarded at runtime,
// so the registration must not appear in instrumentation.ts itself —
// otherwise every dev-server compile logs the warning.
//
// The listener is observe-only: it captures the error and the process still
// terminates with the default non-zero exit code, exactly as it would with
// no listener at all.
import { captureError } from "@/lib/error-monitoring";

let processMonitorRegistered = false;

export function registerProcessErrorMonitor() {
  if (processMonitorRegistered) return;
  processMonitorRegistered = true;
  process.on("uncaughtExceptionMonitor", (error) => {
    captureError(error, { operation: "process-uncaught-exception" });
  });
}
