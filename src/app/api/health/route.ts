// Public health endpoint — GET /api/health.
//
// Reports application health accurately for load balancers, uptime monitors
// and operators. It is intentionally unauthenticated: a health check that
// requires a session cannot be used by infrastructure that has none.
//
// Checks:
// - Database: a bounded `SELECT 1` against the application database
//   (Supabase Postgres via Prisma) with a 5s timeout. A failure means the
//   app cannot serve traffic that needs data.
// - Worker: the in-process payment maintenance worker heartbeat
//   (src/services/worker-heartbeat.ts). A stale/failing/not-started worker
//   degrades the result but does not take the app down: the storefront still
//   serves traffic, but reservation expiry and payment reconciliation are
//   not running.
//
// Safety: the response contains only coarse statuses, ISO timestamps and
// counts. It never includes error messages, stack traces, connection
// strings, environment values, versions or any customer/payment data.
// Responses are never cached.
//
// Statuses:
// - ok: database reachable and worker heartbeat fresh.
// - degraded: database reachable but the worker is stale, failing, stopped
//   or never started (HTTP 200 — the app itself is up).
// - down: database unreachable (HTTP 503).
import { db } from "@/lib/db";
import {
  getWorkerHeartbeat,
  type WorkerHeartbeatSnapshot,
  type WorkerHeartbeatStatus,
} from "@/services/worker-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATABASE_CHECK_TIMEOUT_MS = 5_000;

export type HealthStatus = "ok" | "degraded" | "down";

export type HealthCheck = {
  status: "ok" | "error";
  latencyMs: number;
};

export type HealthPayload = {
  status: HealthStatus;
  timestamp: string;
  checks: {
    database: HealthCheck;
    worker: WorkerHeartbeatSnapshot;
  };
};

export function evaluateHealthStatus(
  databaseOk: boolean,
  workerStatus: WorkerHeartbeatStatus,
): HealthStatus {
  if (!databaseOk) return "down";
  return workerStatus === "healthy" ? "ok" : "degraded";
}

/** Pure payload builder — exported so the status mapping is unit-testable. */
export function buildHealthPayload(
  database: HealthCheck,
  worker: WorkerHeartbeatSnapshot,
  nowMs: number = Date.now(),
): HealthPayload {
  return {
    status: evaluateHealthStatus(database.status === "ok", worker.status),
    timestamp: new Date(nowMs).toISOString(),
    checks: { database, worker },
  };
}

async function checkDatabase(): Promise<HealthCheck> {
  const startedAt = Date.now();
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("database check timed out")),
          DATABASE_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch {
    // Deliberately generic: no error text, no connection detail.
    return { status: "error", latencyMs: Date.now() - startedAt };
  }
}

export async function GET() {
  const [database, worker] = await Promise.all([
    checkDatabase(),
    Promise.resolve(getWorkerHeartbeat()),
  ]);
  const payload = buildHealthPayload(database, worker);
  return Response.json(payload, {
    status: payload.status === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
