// Worker health rows for the admin dashboard Operations card (D15, Stream F).
//
// Renders nothing while BOTH workers are healthy — the card only lists
// things that need attention. When either worker is stale, failing,
// stopped, or never started, a row says so with the last successful sweep
// so an operator can tell a dead worker from a slow one. There is no page
// that resolves a dead worker (recovery is restarting the app server — see
// docs/WORKER-HEALTH.md), so these rows have no link, unlike the queue rows.
// The two workers have independent heartbeats: a healthy payment worker
// never masks a dead outbox worker, and vice versa.
import type { WorkerHeartbeatSnapshot } from "@/services/worker-heartbeat";

function statusLabel(prefix: string, status: string): string {
  switch (status) {
    case "stale":
      return `${prefix} stale`;
    case "failing":
      return `${prefix} failing`;
    case "stopped":
      return `${prefix} stopped`;
    case "not_started":
      return `${prefix} not started`;
    default:
      return `${prefix} unhealthy`;
  }
}

function ageText(worker: WorkerHeartbeatSnapshot): string {
  if (worker.ageMs === null) return "no successful sweep yet";
  if (worker.ageMs < 60_000) return `last sweep ${Math.floor(worker.ageMs / 1_000)}s ago`;
  return `last sweep ${Math.floor(worker.ageMs / 60_000)} min ago`;
}

function HealthRow({
  worker,
  prefix,
}: {
  worker: WorkerHeartbeatSnapshot;
  prefix: string;
}) {
  const detail = [
    ageText(worker),
    worker.sweepsFailed > 0 ? `${worker.sweepsFailed} failed` : null,
    worker.lastFailureCode ? `code ${worker.lastFailureCode}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
      <p className="text-sm">
        <span className="font-bold text-destructive">
          {statusLabel(prefix, worker.status)}
        </span>{" "}
        — {detail}
      </p>
      <p className="text-xs text-muted-foreground">Check GET /api/health</p>
    </li>
  );
}

export function WorkerHealthRow({
  worker,
  outboxWorker,
}: {
  worker: WorkerHeartbeatSnapshot;
  outboxWorker: WorkerHeartbeatSnapshot;
}) {
  if (worker.status === "healthy" && outboxWorker.status === "healthy") return null;
  return (
    <>
      {worker.status !== "healthy" ? (
        <HealthRow worker={worker} prefix="Payment worker" />
      ) : null}
      {outboxWorker.status !== "healthy" ? (
        <HealthRow worker={outboxWorker} prefix="Email outbox worker" />
      ) : null}
    </>
  );
}
