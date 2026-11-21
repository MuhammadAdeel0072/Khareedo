# Worker health check + recovery procedure (D15)

The store has **two in-process background workers**. Nothing about them is
outsourced: they run inside the app server process, on a fixed 60-second
tick. If the process stops, the workers stop. If the workers stop, the
storefront still serves pages — but reservations never expire, webhooks
never reconcile, refunds never submit, and emails never deliver.

This document is the operator runbook: what the workers do, how to tell
whether they are alive, what to alert on, and how to recover. Every claim
here is verifiable against the code cited; nothing aspirational is
documented. The deployment model (single instance, Hostinger VPS, start
command) is in `docs/DEPLOYMENT.md`.

## 1. The two workers

Both start from `src/instrumentation.ts` (`register()`, once per server
process, Node.js runtime only — never during the build). Each has its own
opt-out and they are independent: disabling one never disables the other.

| Worker | File | Interval | First sweep | Opt-out |
|---|---|---|---|---|
| Payment maintenance | `src/services/payment-maintenance-worker.service.ts` | 60 s (min 15 s) | 15 s after start | `PAYMENT_MAINTENANCE_WORKER=off` |
| Email outbox delivery | `src/services/email-outbox.service.ts` (`createEmailOutboxWorker`) | 60 s (min 15 s) | 15 s after start | `EMAIL_OUTBOX_WORKER=off` |

Safety properties both share: **single-flight** (an overlapping tick is
skipped, never queued or run in parallel), **bounded batches**, and an
**unref'd timer** (the worker never keeps the process alive on its own).
Start is guarded by a `globalThis` registry, so starting twice in the same
process is a no-op. A failed sweep never crashes the process: the payment
worker records the failure in the heartbeat and retries next tick; the
outbox worker records the failure in its own heartbeat, raises a
`WORKER_FAILURE` alert, and retries next tick (Stream F). Both workers
are supervised as one process by systemd — see §8.

### 1.1 Payment maintenance worker — sweep plan

One sweep runs these actions **in this order** (from `SWEEP_PLAN` in
`payment-maintenance-worker.service.ts`):

| # | Action | Batch | What it does |
|---|---|---|---|
| 1 | `verify_expiring_payments` | 10 | Force-verifies payments whose reservations expire within 5 min, while settlement is still possible (M-26) |
| 2 | `expire_reservations` | 10 | Closes expired 15-minute reservations: releases stock, or holds for review when the payment may be payable |
| 3 | `process_webhook_inbox` | 10 | Processes stored Safepay webhook events that could not be handled on delivery |
| 4 | `reconcile_due_payments` | 5 | Re-verifies due managed payments against the provider reporter |
| 5 | `reconcile_refunds` | 5 | Submits due refunds (after the 24 h window) and reconciles submitted ones |
| 6 | `cleanup_email_outbox` | 1 | Deletes `FAILED`/`SENT` outbox rows older than 30 days (`PENDING` rows are never deleted) |
| 7 | `prune_stale_carts` | 1 | Deletes guest carts older than 30 days |

Two more actions exist in `MAINTENANCE_ACTIONS`
(`src/services/payment-maintenance.service.ts`) but are **not** in the
sweep — they are manual, single-order actions run from the admin
maintenance endpoint only: `verify_order_payment` and
`investigate_closed_order_payment`.

A sweep action can be **blocked** without failing the sweep: missing
Safepay config (`SAFEPAY_CONFIGURATION_UNAVAILABLE`), missing payload
custody (`PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE`), or refunds outside the
sandbox (`REFUNDS_SANDBOX_ONLY` — refunds are sandbox-only by design until
Safepay live is enabled). A blocked action is logged and retried next
sweep; the sweep still counts as successful. That matters for §3: a
`healthy` heartbeat means the timer runs, not that provider actions are
succeeding. Check the blocked log lines too.

### 1.2 Email outbox worker — delivery loop

Each sweep takes up to 10 `PENDING` rows whose `nextAttemptAt` has passed,
oldest first, and delivers them through the pooled SMTP transporter.
Each row is **claimed atomically** (a 5-minute lease), so two processes
cannot deliver the same row. A failed attempt stays `PENDING` with a
backoff and is retried; after 5 attempts (`EMAIL_OUTBOX_MAX_ATTEMPTS`) the
row becomes `FAILED` and is reported via `captureError`. Delivery covers
password resets, verification mail, and the order/payment/refund emails
(Chunk 7-final).

## 2. Health signals — how to tell whether the workers are alive

### 2.1 `GET /api/health` — the primary check (both workers)

Public, unauthenticated by design (infrastructure has no session),
rate-limited to 300/min globally, never cached
(`src/app/api/health/route.ts`). It probes the database (`SELECT 1`, 5 s
timeout) and reads both worker heartbeats — payment (`checks.worker`)
and email outbox (`checks.outbox`, Stream F, same snapshot shape).
Either worker being unhealthy degrades the result; a healthy payment
worker never masks a dead outbox worker, and vice versa.

```sh
curl -s https://<production-origin>/api/health | python3 -m json.tool
```

Example response (fields are coarse by design — statuses, ISO timestamps,
counts; never error text, connection strings, or customer data):

```json
{
  "status": "degraded",
  "timestamp": "2026-11-20T10:30:00.000Z",
  "checks": {
    "database": { "status": "ok", "latencyMs": 42 },
    "worker": {
      "status": "stale",
      "startedAt": "2026-11-20T09:00:00.000Z",
      "lastSweepStartedAt": "2026-11-20T10:20:00.000Z",
      "lastSweepCompletedAt": "2026-11-20T10:20:01.000Z",
      "lastSuccessAt": "2026-11-20T10:20:01.000Z",
      "lastFailureAt": null,
      "lastFailureCode": null,
      "consecutiveFailures": 0,
      "sweepsCompleted": 84,
      "sweepsFailed": 0,
      "ageMs": 599000,
      "staleAfterMs": 180000
    },
    "outbox": {
      "status": "healthy",
      "startedAt": "2026-11-20T09:00:00.000Z",
      "lastSweepStartedAt": "2026-11-20T10:29:55.000Z",
      "lastSweepCompletedAt": "2026-11-20T10:29:55.000Z",
      "lastSuccessAt": "2026-11-20T10:29:55.000Z",
      "lastFailureAt": null,
      "lastFailureCode": null,
      "consecutiveFailures": 0,
      "sweepsCompleted": 91,
      "sweepsFailed": 0,
      "ageMs": 5000,
      "staleAfterMs": 180000
    }
  }
}
```

Top-level `status` and HTTP code:

| `status` | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | Database reachable **and** both worker heartbeats fresh |
| `degraded` | 200 | Database reachable, either worker stale / failing / stopped / never started. The storefront still serves traffic; expiry and reconciliation (payment worker) or email delivery (outbox worker) are not running |
| `down` | 503 | Database unreachable |

### 2.2 The worker heartbeat — what the fields mean

`src/services/worker-heartbeat.ts`. In-memory, per process (held on
`globalThis` under a Symbol key, so it survives module re-evaluation but
**resets on every process restart**). Each worker has its **own registry
key** (`khareedo.worker-heartbeat` for payment,
`khareedo.outbox-worker-heartbeat` for the outbox worker), so one
worker's sweeps can never mark the other healthy. A worker is **stale**
when no successful sweep has completed for
`WORKER_HEARTBEAT_STALE_AFTER_MS` (**180 s = 3 sweep intervals**), so one
or two missed sweeps do not flap the status. The threshold is the same
for both workers because both sweep every 60 s — the 3-interval rule is
a property of the interval, not of the worker. Statuses:

| Status | Meaning |
|---|---|
| `healthy` | A sweep succeeded within the last 180 s, or the worker started less than 180 s ago and is inside its first-sweep window |
| `stale` | Started, but no successful sweep for over 180 s — the timer is dead or every sweep is failing silently (see `failing` below) |
| `failing` | The most recent sweep threw (takes precedence over staleness). `lastFailureCode` is a generic code only (`SWEEP_FAILED`), never an error message — the underlying error is in the server log via the `WORKER_FAILURE` alert |
| `stopped` | `stop()` was called (tests / shutdown path). In production this means the worker was deliberately stopped |
| `not_started` | No worker has started in this process — e.g. just after a restart, before the first tick, or `PAYMENT_MAINTENANCE_WORKER=off` |

Limitations, stated in the code: each process keeps its own heartbeat, so
a load balancer may see different states per instance. The deployment is
single-instance (`docs/DEPLOYMENT.md`), so this does not apply today; a
cross-instance heartbeat would need a shared store and is out of scope.
The heartbeat records sweep success/failure only. A sweep that finds no
work still counts as a success (a quiet store is a healthy one), and a
sweep whose rows all fail with backoff still counts as a success as long
as the delivery loop itself ran — per-row email failures are visible in
the outbox viewer (§2.4), and blocked payment actions are visible in the
log (§1.1), not in the heartbeat.

### 2.3 Admin dashboard — Operations health card

`/admin` (`src/app/admin/(panel)/page.tsx`) shows an **Operations health**
card with three queue counts, each linking to the page that resolves it:

- failed emails in the outbox → `/admin/email-outbox?status=FAILED`
- payments needing review → `/admin/payments/review`
- expired reservations still holding stock → `/admin/inventory`

Since D15 the card also shows a **payment worker row** whenever the worker
is not healthy (status + time since the last successful sweep + failed
count + last failure code), and since Stream F it shows an **email
outbox worker row** on the same terms — one row per unhealthy worker.
The "All clear — nothing needs attention" line only appears when **both**
workers are healthy
(`src/components/admin/worker-health-row.tsx`). Before Stream F the card
could read "All clear" while the outbox worker was dead: a dead worker
leaves outbox rows `PENDING` (not `FAILED`) and reservations unexpired,
so all three counts can read zero while nothing is running.

### 2.4 Email outbox worker — heartbeat, plus indirect signals

Since Stream F the outbox worker has its own heartbeat
(`recordOutboxSweep*` in `src/services/worker-heartbeat.ts`, recorded by
`createEmailOutboxWorker` in `src/services/email-outbox.service.ts` on
every sweep, with `start()`/`stop()` recording the lifecycle the same
way the payment worker does). It is surfaced in `GET /api/health`
(`checks.outbox`, §2.1) and in the admin Operations card (§2.3). A
sweep that throws raises a `WORKER_FAILURE` alert with code
`OUTBOX_SWEEP_FAILED` — a distinct code from the payment worker's
`SWEEP_FAILED`, because the alert throttle is keyed on kind+code and a
shared code would let a payment-worker alert suppress an outbox alert
inside the 15-minute throttle window. The heartbeat's
`lastFailureCode` stays the generic `SWEEP_FAILED`, matching the
payment worker.

Two indirect signals remain useful as a second opinion (they catch a
worker that sweeps but never delivers, which the heartbeat cannot see —
see §2.2):

1. **Outbox viewer** (`/admin/email-outbox`): `PENDING` rows whose next
   attempt time has passed and whose attempt count is not moving mean the
   worker is not delivering. A single old row with attempts > 0 is normal
   backoff, not a dead worker — the signal is *all* due rows ageing.
2. **Server log**: a delivering worker logs
   `[email-outbox] considered=N delivered=N discarded=N failed=N permanentlyFailed=N`
   whenever a sweep finds work (quiet sweeps log nothing — silence is
   normal when the outbox is empty).

### 2.5 Server log lines

The workers log to the app server's stdout/stderr. Under systemd
(`deploy/khareedo.service`, §8) that is the journal — inspect with:

```sh
sudo journalctl -u khareedo -f            # follow live
sudo journalctl -u khareedo --since "1 hour ago" --no-pager
sudo journalctl -u khareedo -p err --since today --no-pager   # errors/alerts only
sudo journalctl -u khareedo --since "1 hour ago" | grep -E "payments-worker|email-outbox"
```

The repo's start script tees output to `server.log` in the app directory
(`"start": "NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log"` in `package.json`) — but that file exists **only
when the app is started by hand with `npm start`**. The systemd unit
runs `bun` directly without the pipe, so under systemd there is no
`server.log`; the journal is the log. Lines that prove a sweep ran:

```text
[payments-worker] expired reservations released=2 review=1
[payments-worker] webhook inbox considered=3 settled=2
[payments-worker] reconciliation considered=5 settled=1
[payments-worker] action=reconcile_refunds blocked=REFUNDS_SANDBOX_ONLY; retrying next sweep
[payments-worker] sweep failed; retrying next sweep
[email-outbox] considered=4 delivered=4 discarded=0 failed=0 permanentlyFailed=0
```

Note: a quiet store logs almost nothing. **Log volume is not a health
signal** — the heartbeat (§2.2) is. A sweep with nothing to do completes
silently and still counts as a success.

### 2.6 Manual trigger — admin maintenance endpoint

`POST /api/admin/payments/maintenance`
(`src/app/api/admin/payments/maintenance/route.ts`) runs one runner action
once, on demand. Admin MFA session required, 10/min per admin, audited
(`PAYMENT_MAINTENANCE_RUN`). If `SAFEPAY_MAINTENANCE_TOKEN` is set, the
`x-khd-maintenance-token` header must also match (for server-to-server
runners such as an external cron). Body: `{"action": "<one of MAINTENANCE_ACTIONS>", "limit": 10}` (`limit` 1–100,
default 25; `orderId` required for `verify_order_payment` /
`investigate_closed_order_payment`). This is a **stopgap, not a fix**: it
runs one action once; it does not restart a dead timer.

## 3. What breaks when a worker is down

### 3.1 Payment maintenance worker down

| Stalled action | Customer / operator impact |
|---|---|
| `verify_expiring_payments` | A payment captured just before expiry is not force-verified first; expiry may close it into review instead of settling it |
| `expire_reservations` | Reservations never expire: stock stays locked, orders stay `PENDING` past the 15-minute window, customers cannot re-checkout cleanly |
| `process_webhook_inbox` | Stored webhook events never process: a successfully paid checkout whose webhook could not be delivered stays `PENDING` (this is why the worker exists) |
| `reconcile_due_payments` | Due payments are never re-verified against the provider |
| `reconcile_refunds` | Refunds are never submitted and never reconciled; 24 h-window releases never happen |
| `cleanup_email_outbox` | Old `FAILED`/`SENT` rows accumulate (bounded growth, no money impact) |
| `prune_stale_carts` | Guest carts older than 30 days accumulate (bounded growth) |

### 3.2 Email outbox worker down

`PENDING` emails are never delivered: password resets, verification mail,
and all order/payment/refund emails. Rows stay `PENDING` — **not**
`FAILED` — so the Operations card does not flag them from the queue
counts; since Stream F the card flags the dead worker itself instead
(§2.3), and `GET /api/health` reports `checks.outbox.status` (§2.1).
The storefront is unaffected otherwise. On recovery the worker resumes
from the queue; a crashed worker's claimed rows retry after the 5-minute claim
lease. An admin can deliver one batch on demand via
`POST /api/admin/email-outbox/deliver` (admin MFA, 10/min).

## 4. Monitoring checklist (operator-owned)

The deployment operator owns monitoring and heartbeat alerts (D15). Minimum
setup on the Hostinger VPS:

1. **External probe of `GET /api/health` every 30–60 s** from outside the
   VPS (uptime monitor of the operator's choice — no specific product is
   prescribed here). **Alert if `status` is not `"ok"` for 5 consecutive
   minutes.** Five minutes is deliberate: the stale threshold is 180 s,
   so a 5-minute window tolerates one slow sweep and a restart (heartbeat
   resets on restart; expect `not_started` → `healthy` within ~75 s of
   the process starting) without paging on a transient. The probe covers
   **both** workers since Stream F — `status` is `"ok"` only when the
   payment worker **and** the outbox worker are fresh.
2. **Alert email for worker failures.** Set `ERROR_MONITORING_ALERT_EMAIL`
   with SMTP configured (`.env.example`, `docs/ERROR-MONITORING.md`).
   A failed sweep emits a `WORKER_FAILURE` alert (payment worker: code
   `SWEEP_FAILED`; outbox worker: code `OUTBOX_SWEEP_FAILED` — distinct
   codes so the 15-minute per-kind+code throttle cannot suppress one
   worker's alert because of the other's), throttled to one email per 15
   minutes per kind+code. Without the email address, alerts still emit a
   structured log line (`type:"payment-alert"`) — a log aggregator can
   alert on that instead. Also watch for `RECONCILIATION_FAILURE` and
   `PAYMENT_FAILURE` alerts from the runner actions.
3. **Outbox ageing check (second opinion).** Alert if any `PENDING`
   outbox row has a next attempt time more than 10 minutes in the past
   (the outbox worker sweeps every 60 s; 10 minutes is 10 missed sweeps).
   Check via the outbox viewer or a direct read of the `EmailOutbox`
   table. Since Stream F the heartbeat (§2.1) is the primary dead-worker
   signal; this check stays because it catches the case the heartbeat
   cannot — a worker that sweeps but whose rows never deliver (every row
   failing with backoff keeps the heartbeat `healthy`).
4. **Daily glance at the admin dashboard** Operations card — it surfaces
   failed emails, the review queue, expired holds, and now a row for
   **each** worker. **After every deploy, check `GET /api/health` once**:
   a deploy restarts the process, resets both heartbeats, and both
   workers must report `healthy` within ~75 s.
5. **Do not alert on log silence.** A quiet store produces almost no
   worker log lines (§2.5). Alert on the heartbeat and the queues, not on
   log volume.

## 5. Recovery procedure

### 5.1 Confirm the worker is actually down (not merely idle)

1. `curl -s https://<production-origin>/api/health` — note
   `checks.worker.status` **and** `checks.outbox.status`, plus
   `lastSuccessAt` and `ageMs` for the unhealthy one. Either worker can
   be down while the other is healthy.
2. Wait 60–120 s and curl again. If `lastSuccessAt` advances and the
   status returns to `healthy`, the worker was alive (a slow sweep, or
   the first-sweep window after a restart). If the status stays `stale` /
   `failing` and `lastSuccessAt` does not move, the worker is down.
3. Distinguish a dead worker from a dead app: if `/api/health` itself
   fails or times out, the **app server** is down, not just the worker —
   skip to §5.2. Also check `systemctl status khareedo` (§8): a unit in
   `failed` state (restart limit reached) needs the cause fixed before
   it will stay up, not another restart.
4. Check the server log for the last `[payments-worker]` / `[email-outbox]`
   lines and for any `WORKER_FAILURE` alert. A `blocked=...` line is not
   a dead worker (§1.1) — it means the sweep ran but an action is
   unavailable (missing config, or refunds blocked outside the sandbox).
   For the outbox worker, also check the outbox viewer (§2.4): due
   `PENDING` rows ageing with unmoving attempt counts corroborate a dead
   worker; rows failing with backoff (attempts rising) mean the worker
   runs but delivery fails — restart will not fix that, fix SMTP/config.

### 5.2 Restart

There is **no separate worker process to restart**. The workers live
inside the app server process, so recovery is restarting the app:

1. If the app is supervised by systemd (§8), restart the unit — this
   is the normal path:
   ```sh
   sudo systemctl restart khareedo
   ```
   `systemctl restart` stops the old process fully before starting the
   new one, so no second instance can overlap it. If the unit is in
   `failed` state (restart limit reached), use
   `sudo systemctl reset-failed khareedo` first, then start it — but
   only after reading the cause from `systemctl status khareedo` and
   the journal; a restart limit means the process crashed 5 times in
   5 minutes, and restarting blindly just repeats it.
2. If the app was started by hand (no supervisor — e.g. a debugging
   session), stop it **fully** first. Verify nothing is still
   listening on `:3000` before starting a new one (e.g.
   `ss -ltnp | grep ':3000'` should return nothing). Starting a second
   process while the old one still runs means two workers sweeping the
   same rows (§5.4). Then start it again from the app directory with
   the repo's start command: `npm start` (runs
   `NODE_ENV=production bun .next/standalone/server.js`).
3. Do **not** set `PAYMENT_MAINTENANCE_WORKER=off` or
   `EMAIL_OUTBOX_WORKER=off` to "fix" a failing worker — that stops
   expiry, reconciliation, and email delivery entirely. The opt-outs
   exist only for serverless deploys, where an external cron must call
   `POST /api/admin/payments/maintenance` on a schedule instead.

### 5.3 Verify after restart

1. `GET /api/health` — expect **both** `worker.status` and
   `outbox.status` to move `not_started` → `healthy` within ~75 s
   (15 s initial delay + first sweep). The heartbeats reset on restart,
   so `startedAt` and `lastSuccessAt` will be new; that is expected.
2. Server log shows a `[payments-worker]` line on the next sweep that
   finds work, and `[email-outbox]` lines as due emails deliver.
   Under systemd the log is the journal (§2.5); if the app was started
   by hand, it is `server.log` in the app directory.
3. Admin dashboard Operations card: the worker rows clear; the queue
   counts start falling as the backlog drains (review queue,
   `PENDING` outbox rows, expired reservations).
4. If a worker reports `failing` again with the same
   `lastFailureCode`, the restart did not fix the cause — read the
   underlying error from the server log (`WORKER_FAILURE` alert context)
   and fix that instead of restarting repeatedly. For the outbox
   worker, a `failing` status with code `SWEEP_FAILED` in the heartbeat
   corresponds to a `WORKER_FAILURE` alert with code
   `OUTBOX_SWEEP_FAILED` (§2.4).

### 5.4 What NOT to do

- **Never resubmit refunds manually.** `reconcile_refunds` is the only
  submitter, and it submits each due refund exactly once through the
  documented endpoint. A manual resubmission risks a duplicate refund.
- **Never re-run migrations to "fix" the worker.** The worker's state is
  in-memory; migrations change the schema, not the timer.
- **Never delete outbox or audit rows to clear a backlog.** `PENDING`
  rows are the work itself; deleting them deletes undelivered email.
  Retention deletion (30 days, `FAILED`/`SENT` only) is the worker's
  own job.
- **Never run two app server processes at once.** Single-flight is
  per-process only. Two processes sweeping the same rows degrades to
  duplicate work: payment sweeps are idempotent by construction and
  outbox claims are atomic, so this should not corrupt data — but do not
  rely on it; stop the old process fully first (§5.2 step 1).
- **Never treat the manual maintenance endpoint as a substitute for the
  worker.** It runs one action once (§2.6). If the timer is dead, the
  backlog returns within a minute.

### 5.5 Escalation — when a restart is not the answer

A restart fixes a dead timer. It does not resolve the items the worker
found:

- **Payments stuck in review** (`/admin/payments/review`): release or
  consume the hold from the review queue after verified provider
  evidence. The worker never releases a retained hold on its own, by
  design.
- **Refunds stuck `REQUESTED` / `REVIEW_REQUIRED`**: use the admin refund
  flow and the review queue; do not resubmit (see §5.4).
- **Failed emails** (`/admin/email-outbox?status=FAILED`): retry from the
  outbox viewer; check `lastError` on the row and the SMTP config before
  retrying in a loop.
- **Worker failing every sweep with the same code**: the cause is in the
  server log, not the timer. Fix the cause (config, credentials, payload
  custody, provider outage), then restart once.

## 6. Opt-outs and the serverless alternative

Set `PAYMENT_MAINTENANCE_WORKER=off` (and/or `EMAIL_OUTBOX_WORKER=off`)
only on a deployment where the app server does not run long-lived — a
serverless deploy. In that case an external scheduler must call
`POST /api/admin/payments/maintenance` on a schedule (the endpoint
accepts an optional `SAFEPAY_MAINTENANCE_TOKEN` for server-to-server
calls; see §2.6) and `deliverPendingOutboxEmails` for email. On the
long-running Hostinger VPS (D15) both workers stay on: there is no
external scheduler, and turning the workers off with no replacement
leaves reservations, webhooks, refunds, and email undone.

## 8. Process supervision and the single-process guarantee (Stream F)

### 8.1 The systemd unit

`deploy/khareedo.service` is the supervisor for the Hostinger VPS
(Ubuntu ships systemd; if the VPS runs another supervisor this unit
does not apply — **operator to confirm** that systemd is what supervises
the app there, and how the app is currently started). The unit runs the
verified start command from `package.json` — `bun
.next/standalone/server.js` with `NODE_ENV=production` — directly,
without the `| tee server.log` pipe (systemd captures stdout/stderr to
the journal, §2.5). Key settings:

| Setting | Value | Why |
|---|---|---|
| `Type` | `simple` | One foreground process; systemd tracks it by PID |
| `ExecStart` | `<bun path> .next/standalone/server.js` | Real start command; absolute bun path — **operator to confirm** (`command -v bun` on the VPS) |
| `WorkingDirectory` | `/srv/khareedo` (placeholder) | App checkout path on the VPS — **operator to confirm** |
| `User` | `khareedo` (placeholder) | Dedicated non-root user — **operator to confirm** |
| `EnvironmentFile` | `/etc/khareedo/production.env` (placeholder) | Standalone build omits `.env`; secrets come from here — **operator to confirm** path (chmod 600) |
| `Environment` | `NODE_ENV=production`, `PORT=3000` | Production mode; port pinned because the proxy expects `localhost:3000` |
| `Restart` / `RestartSec` | `on-failure` / `10` | Crash recovery: restart 10 s after a failure; a clean `systemctl stop` is never restarted |
| `StartLimitIntervalSec` / `StartLimitBurst` | `300` / `5` | At most 5 restarts in 5 minutes, then the unit holds in `failed` state for the operator to investigate instead of restart-looping |
| `TimeoutStopSec` | `90` | Graceful-stop window (see §8.2) |
| `StandardOutput` / `StandardError` | `journal` | Logs to the journal; no `server.log` under systemd |

The unit file was checked locally with `systemd-analyze verify` (only
finding: the placeholder bun path does not exist in the sandbox, as
expected — it is an operator-to-confirm value). It has **not** been
installed or tested on the VPS: this repo has no access to the Hostinger
server, and the operator must fill in the placeholders and run the
install steps in the unit's header. Until the operator confirms the
values, the supervisor on the VPS remains whatever it is today —
unverified, same as before D15.

### 8.2 Startup, restart, crash recovery, shutdown

- **Startup:** `sudo systemctl enable --now khareedo` (after install).
  The app binds `:3000`; the first sweeps run 15 s after start
  (`initialDelayMs`), so both heartbeats report `healthy` within ~75 s
  (§5.3 step 1). The heartbeat resets on every start, so `startedAt`
  is always the latest process start.
- **Restart:** `sudo systemctl restart khareedo` — stop-then-start, so
  the old process is fully gone before the new one binds `:3000` (§5.2).
- **Crash recovery:** an uncaught exception terminates the process with
  a non-zero exit code (by design — `src/instrumentation.ts` never
  swallows one), and systemd restarts it after 10 s (`Restart=on-failure`).
  A worker sweep that throws does **not** crash the process: the sweep
  records `failing` in its heartbeat, raises a `WORKER_FAILURE` alert,
  and retries next tick — systemd is not involved. Five crashes in five
  minutes trip the restart limit; the unit stays `failed` until the
  operator fixes the cause (`systemctl status khareedo`, journal) and
  runs `sudo systemctl reset-failed khareedo && sudo systemctl start khareedo`.
- **Shutdown (graceful stop):** `sudo systemctl stop khareedo` sends
  SIGTERM and waits up to 90 s (`TimeoutStopSec`) before SIGKILL. The
  standalone server closes its listener on SIGTERM; an in-flight sweep
  finishes its current database operation and the process exits when its
  handles drain. A sweep cut off mid-batch is safe to resume: payment
  sweeps are idempotent by construction, and outbox rows are
  claim-leased for 5 minutes, so the next start redoes the work instead
  of losing or duplicating it. There is no separate worker shutdown —
  stopping the app stops both workers, and starting it starts both.
- **Deploy:** a deploy replaces the build and restarts the unit; both
  heartbeats reset and must return to `healthy` within ~75 s (§4 step 4).
  Never deploy by starting a second process alongside the running unit
  (§8.3).

### 8.3 Only one worker process runs — the guards

Four independent guards, strongest first; no additional lockfile or
leader election was added because the existing guards already cover
every layer, and a lockfile would add a stale-lock failure mode of its
own:

1. **systemd runs a single instance of the unit.** `systemctl start`
   on a running unit is a no-op; `restart` stops the old process
   before starting the new one. Evidence: `deploy/khareedo.service`,
   `Type=simple` (one main process, tracked by PID).
2. **The port bind refuses a second process.** The standalone server
   listens on `:3000`; a second process (by hand, or a stale one left
   running) exits with `EADDRINUSE` instead of serving. Evidence: the
   standalone server binds the port at startup; §5.2 step 2's
   `ss -ltnp | grep ':3000'` check is the manual form of this guard.
3. **Same-process double start is a no-op.** Both `start*` functions
   guard on a `globalThis` registry key, so `register()` running twice
   in one process starts each worker once. Evidence:
   `src/services/payment-maintenance-worker.service.ts`
   (`Symbol.for("khareedo.payment-maintenance-worker")`) and
   `src/services/email-outbox.service.ts`
   (`Symbol.for("khareedo.email-outbox-worker")`); covered by tests
   (`tests/unit/email-outbox.test.ts`, "registers at most one worker
   per process").
4. **Single-flight within a process.** Each worker's `running` flag
   skips an overlapping tick instead of queueing or parallelising it.
   Evidence: `running` guard in both workers' `sweep()`; the outbox
   claim lease (5 min, atomic conditional update) additionally makes
   cross-process double delivery impossible for the same row.

What these guards do **not** do: a second process that somehow binds a
*different* port would sweep the same payment rows (idempotent, so safe
but wasteful) and race the same outbox rows (atomic claims, so at most
one delivers each row). The port guard (2) is what keeps that
hypothetical from happening on this deployment — do not run the app on
a second port.

## 9. File references

| Concern | File |
|---|---|
| Payment worker (sweep plan, interval, single-flight) | `src/services/payment-maintenance-worker.service.ts` |
| Runner (all maintenance actions) | `src/services/payment-maintenance.service.ts` |
| Heartbeat (statuses, 180 s stale threshold, both workers) | `src/services/worker-heartbeat.ts` |
| Health endpoint | `src/app/api/health/route.ts` |
| Outbox worker (delivery loop, claim lease, retries, heartbeat) | `src/services/email-outbox.service.ts` |
| Worker startup (both workers, opt-outs) | `src/instrumentation.ts` |
| Admin dashboard Operations card + worker rows | `src/app/admin/(panel)/page.tsx`, `src/components/admin/worker-health-row.tsx` |
| Manual maintenance trigger | `src/app/api/admin/payments/maintenance/route.ts` |
| On-demand outbox delivery | `src/app/api/admin/email-outbox/deliver/route.ts` |
| Alerts (`WORKER_FAILURE`, throttle, email transport) | `src/lib/error-monitoring.ts`, `docs/ERROR-MONITORING.md` |
| Deployment model (single instance, start command) | `docs/DEPLOYMENT.md`, `package.json` (`start`) |
| Process supervision (systemd unit) | `deploy/khareedo.service` |
| Checkout lifecycle (what the sweeps protect) | `docs/CHECKOUT-LIFECYCLE.md` |
