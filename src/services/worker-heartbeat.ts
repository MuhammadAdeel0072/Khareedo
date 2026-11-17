import "server-only";

// In-process heartbeat for the payment maintenance worker
// (src/services/payment-maintenance-worker.service.ts, started from
// src/instrumentation.ts). The health endpoint (GET /api/health) reads this
// registry to report worker liveness; nothing here touches the database, so a
// heartbeat never depends on — or interferes with — production data.
//
// Design notes:
// - Single-process, in-memory state, held on globalThis under a Symbol key so
//   it survives module re-evaluation (dev reloads, standalone server bundles),
//   mirroring the worker registry in the worker service.
// - Timestamps are epoch milliseconds internally and ISO strings in snapshots.
// - Failure records carry only a sanitised generic code (e.g. SWEEP_FAILED),
//   never an error message, stack trace or payload — nothing sensitive can
//   leak into the health response.
// - A worker that has started but not yet completed a sweep is healthy while
//   it is inside its first-sweep window; it turns stale only after
//   WORKER_HEARTBEAT_STALE_AFTER_MS without a successful sweep. The default
//   sweep interval is 60s, so the stale threshold is 3x the interval: one or
//   two missed sweeps (e.g. a slow sweep or a single transient failure that is
//   still being retried) do not flap the status, but a dead timer does.
// - Multi-instance limitation: each process keeps its own heartbeat. A load
//   balancer hitting /api/health may therefore see different worker states
//   per instance. That matches the current single-instance deployment
//   assumption; a cross-instance heartbeat would need a shared store and is
//   explicitly out of scope for this change.

export const WORKER_HEARTBEAT_STALE_AFTER_MS = 180_000;

export type WorkerHeartbeatStatus =
  | "not_started"
  | "healthy"
  | "stale"
  | "failing"
  | "stopped";

export type WorkerHeartbeatSnapshot = {
  status: WorkerHeartbeatStatus;
  startedAt: string | null;
  lastSweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Generic failure code only — never an error message or stack trace. */
  lastFailureCode: string | null;
  consecutiveFailures: number;
  sweepsCompleted: number;
  sweepsFailed: number;
  /** Milliseconds since the last successful sweep; null when none yet. */
  ageMs: number | null;
  staleAfterMs: number;
};

type WorkerHeartbeatState = {
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  lastSweepStartedAtMs: number | null;
  lastSweepCompletedAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  lastFailureCode: string | null;
  consecutiveFailures: number;
  sweepsCompleted: number;
  sweepsFailed: number;
  /** Monotonic event counter: orders success/failure when both land in the same millisecond. */
  seq: number;
  lastSuccessSeq: number | null;
  lastFailureSeq: number | null;
};

const HEARTBEAT_REGISTRY_KEY = Symbol.for("khareedo.worker-heartbeat");

function freshState(): WorkerHeartbeatState {
  return {
    startedAtMs: null,
    stoppedAtMs: null,
    lastSweepStartedAtMs: null,
    lastSweepCompletedAtMs: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    lastFailureCode: null,
    consecutiveFailures: 0,
    sweepsCompleted: 0,
    sweepsFailed: 0,
    seq: 0,
    lastSuccessSeq: null,
    lastFailureSeq: null,
  };
}

function heartbeatState(): WorkerHeartbeatState {
  const registry = globalThis as Record<symbol, unknown>;
  const existing = registry[HEARTBEAT_REGISTRY_KEY] as
    | WorkerHeartbeatState
    | undefined;
  if (existing) return existing;
  const state = freshState();
  registry[HEARTBEAT_REGISTRY_KEY] = state;
  return state;
}

/** Test-only reset. Production code never clears heartbeat history. */
export function resetWorkerHeartbeat(): void {
  const registry = globalThis as Record<symbol, unknown>;
  registry[HEARTBEAT_REGISTRY_KEY] = freshState();
}

export function recordWorkerStarted(nowMs: number = Date.now()): void {
  const state = heartbeatState();
  state.startedAtMs = nowMs;
  state.stoppedAtMs = null;
}

export function recordWorkerStopped(nowMs: number = Date.now()): void {
  const state = heartbeatState();
  state.stoppedAtMs = nowMs;
}

export function recordSweepStarted(nowMs: number = Date.now()): void {
  const state = heartbeatState();
  // A sweep can only run while the worker is active, so a sweep starting
  // implies the worker started (covers sweepOnce() in tests, which bypasses
  // start()).
  if (state.startedAtMs === null) state.startedAtMs = nowMs;
  state.lastSweepStartedAtMs = nowMs;
}

export function recordSweepSucceeded(nowMs: number = Date.now()): void {
  const state = heartbeatState();
  state.lastSweepCompletedAtMs = nowMs;
  state.lastSuccessAtMs = nowMs;
  state.lastSuccessSeq = ++state.seq;
  state.consecutiveFailures = 0;
  state.sweepsCompleted += 1;
}

const FAILURE_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

export function recordSweepFailed(
  code: string = "SWEEP_FAILED",
  nowMs: number = Date.now(),
): void {
  const state = heartbeatState();
  state.lastSweepCompletedAtMs = nowMs;
  state.lastFailureAtMs = nowMs;
  state.lastFailureSeq = ++state.seq;
  // Sanitise: only a short generic code is stored, never free-form text.
  state.lastFailureCode = FAILURE_CODE_PATTERN.test(code)
    ? code
    : "SWEEP_FAILED";
  state.consecutiveFailures += 1;
  state.sweepsFailed += 1;
}

function toIso(valueMs: number | null): string | null {
  return valueMs === null ? null : new Date(valueMs).toISOString();
}

export function getWorkerHeartbeat(
  nowMs: number = Date.now(),
): WorkerHeartbeatSnapshot {
  const state = heartbeatState();
  const ageMs =
    state.lastSuccessAtMs === null ? null : Math.max(0, nowMs - state.lastSuccessAtMs);

  let status: WorkerHeartbeatStatus;
  if (state.stoppedAtMs !== null) {
    status = "stopped";
  } else if (state.startedAtMs === null) {
    status = "not_started";
  } else if (
    state.lastFailureSeq !== null &&
    (state.lastSuccessSeq === null || state.lastFailureSeq > state.lastSuccessSeq)
  ) {
    // The most recent sweep failed; that is more informative than staleness.
    status = "failing";
  } else if (state.lastSuccessAtMs !== null) {
    status = ageMs !== null && ageMs > WORKER_HEARTBEAT_STALE_AFTER_MS ? "stale" : "healthy";
  } else {
    // Started but no sweep has completed yet: healthy inside the first-sweep
    // window (covers the worker's initial delay), stale once it expires.
    status =
      nowMs - state.startedAtMs > WORKER_HEARTBEAT_STALE_AFTER_MS
        ? "stale"
        : "healthy";
  }

  return {
    status,
    startedAt: toIso(state.startedAtMs),
    lastSweepStartedAt: toIso(state.lastSweepStartedAtMs),
    lastSweepCompletedAt: toIso(state.lastSweepCompletedAtMs),
    lastSuccessAt: toIso(state.lastSuccessAtMs),
    lastFailureAt: toIso(state.lastFailureAtMs),
    lastFailureCode: state.lastFailureCode,
    consecutiveFailures: state.consecutiveFailures,
    sweepsCompleted: state.sweepsCompleted,
    sweepsFailed: state.sweepsFailed,
    ageMs,
    staleAfterMs: WORKER_HEARTBEAT_STALE_AFTER_MS,
  };
}
