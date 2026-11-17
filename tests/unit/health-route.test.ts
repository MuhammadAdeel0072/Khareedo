import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $queryRaw: mocks.queryRaw } }));

import { GET, buildHealthPayload, evaluateHealthStatus } from "@/app/api/health/route";
import {
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  getWorkerHeartbeat,
  recordSweepFailed,
  recordSweepSucceeded,
  recordWorkerStarted,
  recordWorkerStopped,
  resetWorkerHeartbeat,
} from "@/services/worker-heartbeat";

const T0 = 1_780_000_000_000;

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkerHeartbeat();
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("returns 200 ok when the database and worker are healthy", async () => {
    recordWorkerStarted();
    recordSweepSucceeded();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.database).toMatchObject({ status: "ok" });
    expect(typeof body.checks.database.latencyMs).toBe("number");
    expect(body.checks.worker.status).toBe("healthy");
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 200 degraded when the worker never started", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database.status).toBe("ok");
    expect(body.checks.worker.status).toBe("not_started");
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

  it("maps statuses purely: down beats degraded, healthy worker is ok", () => {
    const healthy = getWorkerHeartbeat();
    expect(evaluateHealthStatus(true, "healthy")).toBe("ok");
    expect(evaluateHealthStatus(true, "stale")).toBe("degraded");
    expect(evaluateHealthStatus(true, "failing")).toBe("degraded");
    expect(evaluateHealthStatus(true, "not_started")).toBe("degraded");
    expect(evaluateHealthStatus(true, "stopped")).toBe("degraded");
    expect(evaluateHealthStatus(false, "healthy")).toBe("down");
    expect(evaluateHealthStatus(false, "stale")).toBe("down");
    expect(healthy.status).toBe("not_started");
    const payload = buildHealthPayload({ status: "ok", latencyMs: 3 }, healthy, T0);
    expect(payload.status).toBe("degraded");
    expect(payload.timestamp).toBe(new Date(T0).toISOString());
  });
});
