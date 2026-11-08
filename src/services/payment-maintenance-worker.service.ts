import "server-only";
import { createPaymentMaintenanceRunner, type MaintenanceAction, type MaintenanceRunResult } from "./payment-maintenance.service";

// In-process background worker that executes the SAME bounded maintenance actions as
// the admin maintenance endpoint — reservation expiry, webhook-inbox processing and
// provider reconciliation — on a fixed interval. It exists because a reconciliation
// service that is never scheduled is an incomplete implementation: without a worker
// (or an external cron), a successfully paid sandbox checkout whose webhook cannot be
// delivered would remain PENDING forever.
//
// Safety properties:
// - Reuses the shared runner; no duplicate maintenance logic and no new money-moving code.
// - Single-flight: overlapping ticks are skipped, never queued or parallelized.
// - Bounded batches; every outcome is the result of the existing idempotent settlement
//   pipeline, so repeated sweeps are safe by construction.
// - The timer is unref'd: the worker never keeps a process alive on its own.
// - Opt-out via PAYMENT_MAINTENANCE_WORKER=off (e.g. serverless deploys that should use
//   an external cron hitting the admin maintenance endpoint instead).
// - Logs outcomes only — never tokens, secrets or customer data.

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 15_000;
const DEFAULT_INITIAL_DELAY_MS = 15_000;
const SWEEP_PLAN: Array<{ action: MaintenanceAction; batch: number }> = [
  { action: "expire_reservations", batch: 10 },
  { action: "process_webhook_inbox", batch: 10 },
  { action: "reconcile_due_payments", batch: 5 },
];

export function createPaymentMaintenanceWorker(runner: {
  run(action: MaintenanceAction, batch: number): Promise<MaintenanceRunResult>;
}, options: {
  intervalMs?: number;
  initialDelayMs?: number;
  log?: (message: string) => void;
} = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const log = options.log ?? (message => console.info(message));
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new Error("Maintenance worker interval must be at least 15 seconds.");
  }
  let running = false;
  let suspended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function sweep(): Promise<void> {
    if (running || suspended) return;
    running = true;
    try {
      for (const step of SWEEP_PLAN) {
        if (suspended) break;
        const result = await runner.run(step.action, step.batch);
        if ("blocked" in result) continue; // Custody/config unavailable — retried next sweep.
        if (result.action === "expire_reservations" && "released" in result &&
            (result.released > 0 || result.reviewRequired > 0)) {
          log(`[payments-worker] expired reservations released=${result.released} review=${result.reviewRequired}`);
        }
        if (result.action === "process_webhook_inbox" && "considered" in result && result.considered > 0) {
          const settled = result.outcomes.filter(o => o.result === "settled").length;
          log(`[payments-worker] webhook inbox considered=${result.considered} settled=${settled}`);
        }
        if (result.action === "reconcile_due_payments" && "considered" in result && result.considered > 0) {
          const settled = result.outcomes.filter(o => o.outcome === "settled").length;
          if (settled > 0) log(`[payments-worker] reconciliation considered=${result.considered} settled=${settled}`);
        }
      }
    } catch {
      // A failed sweep is retried on the next tick; no partial state can exist because
      // every action is transactional/idempotent.
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void sweep(); }, intervalMs);
      // Do not hold the event loop open for maintenance work.
      timer.unref?.();
      void setTimeout(() => { void sweep(); }, Math.min(initialDelayMs, intervalMs)).unref?.();
    },
    stop(): void {
      suspended = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    /** Exposed for tests: runs exactly one bounded sweep, bypassing the timer. */
    async sweepOnce(): Promise<void> {
      await sweep();
    },
  };
}

const WORKER_REGISTRY_KEY = Symbol.for("khareedo.payment-maintenance-worker");

/** Wires the real runner and starts the worker exactly once per server process. */
export function startPaymentMaintenanceWorker(options: { intervalMs?: number } = {}): void {
  if (process.env.PAYMENT_MAINTENANCE_WORKER === "off") return;
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[WORKER_REGISTRY_KEY]) return;
  const worker = createPaymentMaintenanceWorker(createPaymentMaintenanceRunner(), {
    intervalMs: options.intervalMs,
  });
  registry[WORKER_REGISTRY_KEY] = worker;
  worker.start();
}
