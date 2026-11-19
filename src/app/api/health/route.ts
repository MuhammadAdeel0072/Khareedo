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
import { rateLimit } from "@/lib/rate-limit";
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

// Database liveness probe.
//
// The 5s timeout is a response deadline only, not query cancellation: Prisma
// 6's `$queryRaw` accepts no AbortSignal, so a timed-out query cannot be
// cancelled from here and may run to completion on the server. That is safe
// for this probe because the query is a read-only `SELECT 1`: it takes no
// locks, writes nothing and returns one row, so it cannot consume meaningful
// database resources. The worst case is one pooled connection held until the
// driver settles the query (completion, or connection failure releasing it),
// and the pool is capped. A late rejection after the timeout wins is
// swallowed (see below) so it can never surface as an unhandled rejection.
async function checkDatabase(): Promise<HealthCheck> {
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = db.$queryRaw`SELECT 1`;
    // If the timeout wins the race below, the query promise is no longer
    // observed — a late rejection would otherwise become an unhandled
    // rejection. Swallow it here; the race still observes the original.
    void query.catch(() => {});
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("database check timed out")),
        DATABASE_CHECK_TIMEOUT_MS,
      );
    });
    await Promise.race([query, timeout]);
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch {
    // Deliberately generic: no error text, no connection detail.
    return { status: "error", latencyMs: Date.now() - startedAt };
  } finally {
    // Always clear the timer: a completed query must not leave a 5s timer
    // holding the event loop, and a fired timer needs no clearing.
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function GET() {
  // A global-only bucket (Phase 2, area A): the endpoint is unauthenticated
  // by design, so there is no per-client identity to key on, and a per-IP
  // bucket would be evadable via spoofed headers until a trusted proxy is
  // configured. 300/min is far above any legitimate monitor (typically one
  // probe every 10-30s); beyond it the endpoint answers 429 instead of
  // burning a database probe per request.
  const limit = rateLimit("health:global", 300, 60 * 1000);
  if (!limit.ok) {
    return Response.json(
      { ok: false, error: `Too many requests. Please try again in ${limit.retryAfterSec}s.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec), "Cache-Control": "no-store" } },
    );
  }
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
