import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";

interface PerformanceContext {
  requestId: string;
  operation: string;
}

export const isDebugLoggingEnabled = process.env.LOG_LEVEL?.toLowerCase() === "debug";
export const isPerformanceLoggingEnabled =
  process.env.NODE_ENV === "development" || isDebugLoggingEnabled;
const SLOW_OPERATION_THRESHOLD_MS = 1_000;
/** Opt-in sampling of non-slow operations in production (0 = off, the
 *  default). A sampled line carries only operation + durationMs — never
 *  arguments, user data, or error text — so it is safe to enable on a
 *  live store. Kept off by default so production stays quiet except for
 *  genuinely slow operations; the existing tests assert that silence. */
const PERFORMANCE_SAMPLE_RATE = Number(process.env.PERFORMANCE_SAMPLE_RATE ?? 0);
const isSamplingEnabled =
  Number.isFinite(PERFORMANCE_SAMPLE_RATE) &&
  PERFORMANCE_SAMPLE_RATE > 0 &&
  PERFORMANCE_SAMPLE_RATE <= 1;

const performanceContext = new AsyncLocalStorage<PerformanceContext>();
const cachedRequestId = cache(() => randomUUID());

export function getPerformanceRequestId() {
  return performanceContext.getStore()?.requestId ?? cachedRequestId();
}

export function getPerformanceContext() {
  return performanceContext.getStore();
}

export async function withPerformanceMeasurement<T>(
  operation: string,
  run: () => T | Promise<T>,
  requestId = getPerformanceRequestId()
): Promise<T> {
  if (!isPerformanceLoggingEnabled) return run();

  const context = { requestId, operation };
  const startedAt = performance.now();

  return performanceContext.run(context, async () => {
    try {
      return await run();
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      logOperationCompletion(operation, durationMs);
    }
  });
}

/** Log one completed operation, production-safe by construction: slow
 *  operations (>1s) always warn; everything else logs only when sampling
 *  is explicitly enabled via PERFORMANCE_SAMPLE_RATE. Both lines carry
 *  operation + durationMs only — no arguments, payloads, or user data. */
function logOperationCompletion(operation: string, durationMs: number) {
  if (durationMs >= SLOW_OPERATION_THRESHOLD_MS) {
    console.warn(
      `[performance:slow] operation=${operation} durationMs=${durationMs}`
    );
  } else if (isSamplingEnabled && Math.random() < PERFORMANCE_SAMPLE_RATE) {
    console.info(
      `[performance:sample] operation=${operation} durationMs=${durationMs}`
    );
  }
}

export async function withPerformanceTiming<T>(
  operation: string,
  run: () => Promise<T>,
  requestId?: string
): Promise<T> {
  // Production-safe, unlike withPerformanceMeasurement below: the timing
  // context is always established (so getPerformanceRequestId threads the
  // request id into captureError), but nothing is logged for a fast
  // operation unless sampling is explicitly enabled — a slow operation
  // is the only thing that ever writes a line by default. That is the
  // production observability the checkout path needs: a 7s place-order
  // shows up as [performance:slow] instead of vanishing silently.
  const parent = performanceContext.getStore();
  const context = {
    requestId: requestId ?? parent?.requestId ?? randomUUID(),
    operation,
  };
  const startedAt = performance.now();

  return performanceContext.run(context, async () => {
    try {
      return await run();
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      logOperationCompletion(operation, durationMs);
    }
  });
}
