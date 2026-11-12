import { describe, expect, it, vi } from "vitest";
import { createPaymentMaintenanceWorker, startPaymentMaintenanceWorker } from "@/services/payment-maintenance-worker.service";
import type { MaintenanceAction, MaintenanceRunResult } from "@/services/payment-maintenance.service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function runnerWithLog() {
  const calls: Array<{ action: string; batch: number }> = [];
  const logs: string[] = [];
  return {
    calls, logs,
    runner: {
      run: vi.fn(async (action: MaintenanceAction, batch: number): Promise<MaintenanceRunResult> => {
        calls.push({ action, batch });
        switch (action) {
          case "expire_reservations":
            return { action, batch, released: 1, reviewRequired: 0, failed: 0 };
          case "process_webhook_inbox":
            return { action, batch, considered: 1, outcomes: [{ eventId: "e", result: "settled" }] };
          case "reconcile_due_payments":
            return { action, batch, considered: 2, outcomes: [{ paymentId: "p", outcome: "settled" }] };
          case "reconcile_refunds":
            return { action, batch, considered: 1, outcomes: [{ refundId: "r", disposition: "submitted", outcome: "submitted" }] };
          default:
            return { action, blocked: true, code: "SAFEPAY_CONFIGURATION_UNAVAILABLE" };
        }
      }),
    },
  };
}

describe("Payment maintenance worker", () => {
  it("runs the full bounded sweep plan in order", async () => {
    const { runner, calls, logs } = runnerWithLog();
    const worker = createPaymentMaintenanceWorker(runner, { log: m => logs.push(m) });
    await worker.sweepOnce();
    expect(calls.map(c => c.action)).toEqual([
      "expire_reservations", "process_webhook_inbox", "reconcile_due_payments", "reconcile_refunds",
    ]);
    expect(calls.map(c => c.batch)).toEqual([10, 10, 5, 5]);
    expect(logs.some(l => l.includes("settled=1"))).toBe(true);
  });

  it("is single-flight: overlapping sweeps are skipped, not queued", async () => {
    const gate = deferred<void>();
    const run = vi.fn(async () => {
      await gate.promise;
      return { action: "expire_reservations", batch: 10, released: 0, reviewRequired: 0, failed: 0 } as MaintenanceRunResult;
    });
    const worker = createPaymentMaintenanceWorker({ run }, { log: () => {} });
    const first = worker.sweepOnce();
    await worker.sweepOnce(); // must return immediately, without starting a second sweep
    gate.resolve();
    await first;
    // Exactly one full sweep (4 bounded actions) ran; the concurrent call never queued work.
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("continues past blocked actions and never throws", async () => {
    const run = vi.fn(async (action: MaintenanceAction, batch: number): Promise<MaintenanceRunResult> => {
      if (action === "process_webhook_inbox") {
        return { action, blocked: true, code: "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE" };
      }
      if (action === "expire_reservations") {
        return { action, batch, released: 0, reviewRequired: 0, failed: 0 };
      }
      if (action === "reconcile_due_payments") {
        return { action, batch, considered: 0, outcomes: [] };
      }
      if (action === "reconcile_refunds") {
        return { action, batch, considered: 0, outcomes: [] };
      }
      return { action, orderId: "o", outcome: "skipped", code: "NOT_ELIGIBLE" };
    });
    const worker = createPaymentMaintenanceWorker({ run }, { log: () => {} });
    await expect(worker.sweepOnce()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("rejects intervals below the 15 second floor", () => {
    expect(() => createPaymentMaintenanceWorker({ run: async () => { throw new Error("unused"); } }, { intervalMs: 1000 }))
      .toThrow();
  });

  it("registers at most one worker per process and honours the opt-out", async () => {
    const registry = globalThis as Record<symbol, unknown>;
    const key = Symbol.for("khareedo.payment-maintenance-worker");
    const previous = process.env.PAYMENT_MAINTENANCE_WORKER;
    const previousWorker = registry[key];
    delete registry[key];
    try {
      process.env.PAYMENT_MAINTENANCE_WORKER = "off";
      expect(() => startPaymentMaintenanceWorker()).not.toThrow();
      expect(registry[key]).toBeUndefined();

      process.env.PAYMENT_MAINTENANCE_WORKER = "on";
      startPaymentMaintenanceWorker();
      const first = registry[key];
      expect(first).toBeDefined();
      startPaymentMaintenanceWorker();
      expect(registry[key]).toBe(first); // second call reused the registered worker
      if (first && typeof first === "object" && "stop" in first) {
        (first as { stop(): void }).stop();
      }
    } finally {
      delete registry[key];
      registry[key] = previousWorker;
      process.env.PAYMENT_MAINTENANCE_WORKER = previous;
    }
  });


it("recovers from a failed sweep and blocked webhook action", async () => {
  const logs: string[] = [];
  const actualRunner = runnerWithLog().runner;

  let failOnce = true;
  let blockWebhookOnce = true;

  const run = vi.fn(
    async (
      action: MaintenanceAction,
      batch: number
    ): Promise<MaintenanceRunResult> => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Simulated temporary outage");
      }

      if (
        action === "process_webhook_inbox" &&
        blockWebhookOnce
      ) {
        blockWebhookOnce = false;

        return {
          action,
          blocked: true,
          code: "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE",
        };
      }

      return actualRunner.run(action, batch);
    }
  );

  const worker = createPaymentMaintenanceWorker(
    { run },
    { log: message => logs.push(message) }
  );

  // First sweep fails.
  await expect(worker.sweepOnce()).resolves.toBeUndefined();

  expect(logs.some(message =>
    message.includes("sweep failed")
  )).toBe(true);

  // Second sweep resumes, but webhook processing is blocked.
  await worker.sweepOnce();

  expect(logs.some(message =>
    message.includes("blocked=PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE")
  )).toBe(true);

  // Third sweep succeeds, including webhook and refund reconciliation.
  await worker.sweepOnce();

  expect(run).toHaveBeenCalledTimes(9);

  expect(
    actualRunner.run.mock.calls.some(
      ([action]) => action === "process_webhook_inbox"
    )
  ).toBe(true);
});


});
