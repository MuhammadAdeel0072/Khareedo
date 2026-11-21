import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $queryRaw: mocks.queryRaw } }));

import { GET, buildHealthPayload, evaluateHealthStatus } from "@/app/api/health/route";
import {
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  getOutboxWorkerHeartbeat,
  getWorkerHeartbeat,
  recordOutboxSweepFailed,
  recordOutboxSweepSucceeded,
  recordOutboxWorkerStarted,
  recordSweepFailed,
  recordSweepSucceeded,
  recordWorkerStarted,
  recordWorkerStopped,
  resetOutboxWorkerHeartbeat,
  resetWorkerHeartbeat,
} from "@/services/worker-heartbeat";

const T0 = 1_780_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkerHeartbeat();
    resetOutboxWorkerHeartbeat();
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("returns 200 ok when the database and BOTH workers are healthy", async () => {
    recordWorkerStarted();
    recordSweepSucceeded();
    recordOutboxWorkerStarted();
    recordOutboxSweepSucceeded();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.database).toMatchObject({ status: "ok" });
    expect(typeof body.checks.database.latencyMs).toBe("number");
    expect(body.checks.worker.status).toBe("healthy");
    expect(body.checks.outbox.status).toBe("healthy");
    expect(body.checks.outbox.staleAfterMs).toBe(WORKER_HEARTBEAT_STALE_AFTER_MS);
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 200 degraded when the worker never started", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database.status).toBe("ok");
    expect(body.checks.worker.status).toBe("not_started");
    expect(body.checks.outbox.status).toBe("not_started");
  });

  it("returns 200 degraded when the outbox worker is stale, even with a healthy payment worker", async () => {
    // Stale proof for the outbox heartbeat: the payment worker succeeded
    // just now, but the outbox worker's last success is older than the
    // 180 s stale window — the endpoint must degrade, not hide behind the
    // healthy payment worker.
    recordWorkerStarted();
    recordSweepSucceeded();
    recordOutboxWorkerStarted(T0);
    recordOutboxSweepSucceeded(T0);
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.status).toBe("healthy");
    expect(body.checks.outbox.status).toBe("stale");
    expect(body.checks.outbox.ageMs).toBeGreaterThan(WORKER_HEARTBEAT_STALE_AFTER_MS);
  });

  it("returns 200 degraded when the outbox worker never started, even with a healthy payment worker", async () => {
    recordWorkerStarted();
    recordSweepSucceeded();
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.status).toBe("healthy");
    expect(body.checks.outbox.status).toBe("not_started");
  });

  it("returns 200 degraded when the outbox worker's last sweep failed", async () => {
    recordWorkerStarted();
    recordSweepSucceeded();
    recordOutboxWorkerStarted();
    recordOutboxSweepSucceeded();
    recordOutboxSweepFailed("SWEEP_FAILED");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.status).toBe("healthy");
    expect(body.checks.outbox.status).toBe("failing");
    expect(body.checks.outbox.consecutiveFailures).toBe(1);
  });

  it("returns 200 degraded when the worker heartbeat is stale", async () => {
    recordWorkerStarted(T0);
    recordSweepSucceeded(T0);
    // Real clock is far past T0, so the last success is older than the stale window.
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.status).toBe("stale");
    expect(body.checks.worker.ageMs).toBeGreaterThan(WORKER_HEARTBEAT_STALE_AFTER_MS);
  });

  it("returns 200 degraded when the last sweep failed", async () => {
    recordWorkerStarted();
    recordSweepSucceeded();
    recordSweepFailed("SWEEP_FAILED");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.status).toBe("failing");
    expect(body.checks.worker.consecutiveFailures).toBe(1);
  });

  it("returns 200 degraded when the worker stopped", async () => {
    recordWorkerStarted();
    recordSweepSucceeded();
    recordWorkerStopped();
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.status).toBe("stopped");
  });

  it("clears the timeout timer when the database query completes first", async () => {
    vi.useFakeTimers();
    try {
      recordWorkerStarted();
      recordSweepSucceeded();
      const response = await GET();
      expect(response.status).toBe(200);
      // The 5s timer must not survive a fast query and hold the event loop.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 503 down when the database check times out, and swallows a late query failure", async () => {
    vi.useFakeTimers();
    try {
      const query = deferred<unknown>();
      mocks.queryRaw.mockReturnValue(query.promise);
      recordWorkerStarted();
      recordSweepSucceeded();
      const responsePromise = GET();
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.status).toBe("down");
      expect(body.checks.database).toMatchObject({ status: "error" });
      expect(body.checks.database.latencyMs).toBe(5_000);
      // The query is still pending after the timeout wins; a late failure
      // must not surface as an unhandled rejection or change the response.
      query.reject(new Error("late database failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(response.status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 503 down when the database is unreachable, without leaking details", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    recordWorkerStarted();
    recordSweepSucceeded();
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("down");
    expect(body.checks.database.status).toBe("error");
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("10.0.0.5");
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("password");
    expect(serialised).not.toContain("SUPABASE");
    expect(serialised).not.toContain("stack");
  });

  it("maps statuses purely: down beats degraded, both workers healthy is ok", () => {
    const healthy = getWorkerHeartbeat();
    const outboxHealthy = getOutboxWorkerHeartbeat();
    expect(evaluateHealthStatus(true, "healthy")).toBe("ok");
    expect(evaluateHealthStatus(true, "healthy", "healthy")).toBe("ok");
    expect(evaluateHealthStatus(true, "stale")).toBe("degraded");
    expect(evaluateHealthStatus(true, "failing")).toBe("degraded");
    expect(evaluateHealthStatus(true, "not_started")).toBe("degraded");
    expect(evaluateHealthStatus(true, "stopped")).toBe("degraded");
    // One unhealthy worker degrades the result, whichever it is.
    expect(evaluateHealthStatus(true, "healthy", "stale")).toBe("degraded");
    expect(evaluateHealthStatus(true, "healthy", "failing")).toBe("degraded");
    expect(evaluateHealthStatus(true, "healthy", "not_started")).toBe("degraded");
    expect(evaluateHealthStatus(true, "healthy", "stopped")).toBe("degraded");
    expect(evaluateHealthStatus(true, "stale", "stale")).toBe("degraded");
    expect(evaluateHealthStatus(false, "healthy")).toBe("down");
    expect(evaluateHealthStatus(false, "stale")).toBe("down");
    expect(evaluateHealthStatus(false, "healthy", "healthy")).toBe("down");
    expect(healthy.status).toBe("not_started");
    expect(outboxHealthy.status).toBe("not_started");
    const payload = buildHealthPayload({ status: "ok", latencyMs: 3 }, healthy, outboxHealthy, T0);
    expect(payload.status).toBe("degraded");
    expect(payload.timestamp).toBe(new Date(T0).toISOString());
    expect(payload.checks.outbox.status).toBe("not_started");
    const okPayload = buildHealthPayload(
      { status: "ok", latencyMs: 3 },
      { ...healthy, status: "healthy" },
      { ...outboxHealthy, status: "healthy" },
      T0,
    );
    expect(okPayload.status).toBe("ok");
  });
});
