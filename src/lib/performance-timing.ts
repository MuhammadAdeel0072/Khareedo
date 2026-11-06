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
      if (durationMs >= SLOW_OPERATION_THRESHOLD_MS) {
        console.warn(`[performance:slow] operation=${operation} durationMs=${durationMs}`);
      }
    }
  });
}

export async function withPerformanceTiming<T>(
  operation: string,
  run: () => Promise<T>,
  requestId?: string
): Promise<T> {
  if (process.env.NODE_ENV === "production" && !isDebugLoggingEnabled) return run();

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
      if (durationMs >= SLOW_OPERATION_THRESHOLD_MS) {
        console.warn(
          `[performance:slow] operation=${operation} durationMs=${durationMs}`
        );
      }
    }
  });
}
