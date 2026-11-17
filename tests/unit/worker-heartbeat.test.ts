import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  getWorkerHeartbeat,
  recordSweepFailed,
  recordSweepStarted,
  recordSweepSucceeded,
  recordWorkerStarted,
  recordWorkerStopped,
  resetWorkerHeartbeat,
} from "@/services/worker-heartbeat";
import { createPaymentMaintenanceWorker } from "@/services/payment-maintenance-worker.service";
import type { MaintenanceAction, MaintenanceRunResult } from "@/services/payment-maintenance.service";

const T0 = 1_780_000_000_000; // fixed base time, keeps the tests deterministic

function okRunner() {
  return {
    run: vi.fn(async (action: MaintenanceAction, batch: number): Promise<MaintenanceRunResult> => {
      switch (action) {
        case "expire_reservations":
          return { action, batch, released: 0, reviewRequired: 0, failed: 0 };
        case "process_webhook_inbox":
          return { action, batch, considered: 0, outcomes: [] };
        case "reconcile_due_payments":
          return { action, batch, considered: 0, outcomes: [] };
        case "reconcile_refunds":
          return { action, batch, considered: 0, outcomes: [] };
        default:
          return { action: "reconcile_refunds", batch, considered: 0, outcomes: [] };
      }
    }),
  };
}

describe("worker heartbeat", () => {
  beforeEach(() => {
    resetWorkerHeartbeat();
  });

  it("starts as not_started with empty timestamps", () => {
    const heartbeat = getWorkerHeartbeat(T0);
    expect(heartbeat.status).toBe("not_started");
    expect(heartbeat.startedAt).toBeNull();
    expect(heartbeat.lastSuccessAt).toBeNull();
    expect(heartbeat.lastFailureAt).toBeNull();
    expect(heartbeat.ageMs).toBeNull();
    expect(heartbeat.consecutiveFailures).toBe(0);
    expect(heartbeat.staleAfterMs).toBe(WORKER_HEARTBEAT_STALE_AFTER_MS);
  });

  it("is healthy after a successful sweep, with ISO timestamps", () => {
    recordWorkerStarted(T0);
    recordSweepStarted(T0);
    recordSweepSucceeded(T0 + 500);
    const heartbeat = getWorkerHeartbeat(T0 + 1_000);
    expect(heartbeat.status).toBe("healthy");
    expect(heartbeat.startedAt).toBe(new Date(T0).toISOString());
    expect(heartbeat.lastSuccessAt).toBe(new Date(T0 + 500).toISOString());
    expect(heartbeat.ageMs).toBe(500);
    expect(heartbeat.sweepsCompleted).toBe(1);
    expect(heartbeat.consecutiveFailures).toBe(0);
  });

  it("is healthy inside the first-sweep window before any sweep completes", () => {
    recordWorkerStarted(T0);
    expect(getWorkerHeartbeat(T0 + 60_000).status).toBe("healthy");
  });

  it("turns stale when no sweep succeeds within the stale window", () => {
    recordWorkerStarted(T0);
    recordSweepSucceeded(T0);
    expect(getWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS).status).toBe("healthy");
    expect(getWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS + 1).status).toBe("stale");
    const heartbeat = getWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS + 1);
    expect(heartbeat.ageMs).toBe(WORKER_HEARTBEAT_STALE_AFTER_MS + 1);
  });

  it("turns stale when started but no sweep ever completes", () => {
    recordWorkerStarted(T0);
    expect(getWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS + 1).status).toBe("stale");
  });

  it("reports failing after a failed sweep and recovers on the next success", () => {
    recordWorkerStarted(T0);
    recordSweepSucceeded(T0);
    recordSweepFailed("SWEEP_FAILED", T0 + 60_000);
    const failing = getWorkerHeartbeat(T0 + 60_000);
    expect(failing.status).toBe("failing");
    expect(failing.consecutiveFailures).toBe(1);
    expect(failing.sweepsFailed).toBe(1);
    expect(failing.lastFailureCode).toBe("SWEEP_FAILED");
    expect(failing.lastFailureAt).toBe(new Date(T0 + 60_000).toISOString());

    recordSweepFailed("SWEEP_FAILED", T0 + 120_000);
    expect(getWorkerHeartbeat(T0 + 120_000).consecutiveFailures).toBe(2);

    recordSweepSucceeded(T0 + 180_000);
    const recovered = getWorkerHeartbeat(T0 + 180_000);
    expect(recovered.status).toBe("healthy");
    expect(recovered.consecutiveFailures).toBe(0);
  });

  it("never stores free-form failure text, only a generic code", () => {
    recordWorkerStarted(T0);
    recordSweepFailed("connection to postgres://user:secret@host failed\nError: boom", T0);
    const heartbeat = getWorkerHeartbeat(T0);
    expect(heartbeat.lastFailureCode).toBe("SWEEP_FAILED");
    expect(JSON.stringify(heartbeat)).not.toContain("secret");
    expect(JSON.stringify(heartbeat)).not.toContain("boom");
  });

  it("reports stopped after the worker stops", () => {
    recordWorkerStarted(T0);
    recordSweepSucceeded(T0);
    recordWorkerStopped(T0 + 1_000);
    expect(getWorkerHeartbeat(T0 + 1_000).status).toBe("stopped");
  });

  it("is updated by the real worker on sweep success and failure", async () => {
    const worker = createPaymentMaintenanceWorker(okRunner(), { log: () => {} });
    await worker.sweepOnce();
    const afterSuccess = getWorkerHeartbeat();
    expect(afterSuccess.sweepsCompleted).toBe(1);
    expect(afterSuccess.status).toBe("healthy");
    expect(afterSuccess.lastSuccessAt).not.toBeNull();

    const failingRunner = {
      run: vi.fn(async (): Promise<MaintenanceRunResult> => {
        throw new Error("Simulated temporary outage");
      }),
    };
    const failingWorker = createPaymentMaintenanceWorker(failingRunner, { log: () => {} });
    await expect(failingWorker.sweepOnce()).resolves.toBeUndefined();
    const afterFailure = getWorkerHeartbeat();
    expect(afterFailure.status).toBe("failing");
    expect(afterFailure.consecutiveFailures).toBe(1);
    expect(afterFailure.sweepsFailed).toBe(1);
  });

  it("records worker start and stop through the worker lifecycle", () => {
    const worker = createPaymentMaintenanceWorker(okRunner(), { log: () => {} });
    worker.start();
    expect(getWorkerHeartbeat().status).not.toBe("not_started");
    worker.stop();
    expect(getWorkerHeartbeat().status).toBe("stopped");
  });
});
