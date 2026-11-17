# Error monitoring and payment alerts

Khareedo captures unexpected server-side errors centrally and alerts operators
about critical payment failures. There is **no vendor SDK** installed: the
only prior intent was the "Sentry boundary" note in
`docs/REQUIREMENTS-TRACEABILITY.md` (NFR-09), and no DSN was available, so
this PR builds a vendor-neutral module on the patterns the codebase already
has — structured console logging, the existing SMTP setup, and the central
route handler. A Sentry transport can be added later behind the same
`captureError` / `capturePaymentAlert` calls without touching call sites.

## What is captured

| Source | How | What is reported |
| --- | --- | --- |
| Any route wrapped in `handleRoute` (`src/lib/api.ts`) | `captureError` on unexpected throws | Sanitised error name/message, operation `api-route`, request id |
| Process-level failures (`src/instrumentation.ts`) | `uncaughtExceptionMonitor` listener (observe-only) | Same, operation `process-uncaught-exception` |
| Worker start failure (`src/instrumentation.ts`) | `captureError` | Operation `payment-maintenance-worker-start` |
| Worker sweep failure (`payment-maintenance-worker.service.ts`) | `WORKER_FAILURE` alert | Code `SWEEP_FAILED` |
| Webhook receive failure (`src/app/api/webhooks/safepay/route.ts`) | `WEBHOOK_FAILURE` alert | `PERSISTENCE_UNAVAILABLE`, `BUSY`, `QUARANTINED`, `CONFLICT` (+ event id) |
| Blocked inbox processing (`payment-maintenance.service.ts`) | `WEBHOOK_FAILURE` alert | `INBOX_PROCESSING_BLOCKED`, count, first event id |
| Failed refund submission (runner, `reconcile_refunds`) | `PAYMENT_FAILURE` alert | Provider code, count |
| Provider fetch failure (runner: `reconcile_due_payments`, `verify_order_payment`, `reconcile_refunds`) | `RECONCILIATION_FAILURE` alert | Provider code, count, payment/order id |

Deliberately **not** alerted: terminal `INVALID_INPUT` webhook deliveries
(a malformed delivery is a provider/client error, not a system failure, and
alerting on it would be a spam vector) and blocked maintenance actions
(config/custody unavailable — the worker retries them next sweep and the
admin endpoint reports them to the caller).

## Transports

1. **Structured log (always).** Every capture emits one JSON line on
   `console.error`, e.g. `{"level":"error","type":"payment-alert","kind":"WEBHOOK_FAILURE","code":"QUARANTINED","eventId":"evt-…","environment":"production","timestamp":"…"}`.
   Any log aggregator can alert on `type:"payment-alert"`. This transport is
   the baseline: it works with no credentials at all, so a failure is never
   silently dropped when alerting is unconfigured.
2. **Email (critical payment alerts only).** When
   `ERROR_MONITORING_ALERT_EMAIL` is set and SMTP is configured
   (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `NEXTAUTH_URL` — see
   `.env.example`), `capturePaymentAlert` also sends a throttled email via
   `sendAlertEmail` in `src/services/email.service.ts`, reusing the same
   pooled SMTP transporter as verification mail. Generic `captureError`
   calls do not email.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ERROR_MONITORING_ENABLED` | `true` | Set to `false` to disable all capture (logs and alerts). |
| `ERROR_MONITORING_ENVIRONMENT` | `NODE_ENV` or `development` | Environment label on every event. |
| `ERROR_MONITORING_ALERT_EMAIL` | _(unset)_ | Recipient for critical payment alerts. Unset → email alerts off, log lines still emitted. |
| `ERROR_MONITORING_ALERT_THROTTLE_MS` | `900000` (15 min) | Minimum gap between two emails for the same alert kind+code. |

When credentials are absent — no alert email, or SMTP not configured —
email alerting is skipped silently and the structured log line is still
emitted. Alert delivery failures never throw into the request path; a failed
send is logged once as `type:"payment-alert-delivery-failed"`.

## Safety: what never leaves the server

- **Context is an allowlist** (`ErrorContext` in `src/lib/error-monitoring.ts`):
  operation, code, request id, payment id, order id, event id, count.
  There is no way to pass a payload, customer record, token or credential
  through context — the type does not have a field for it, and tests assert
  non-allowlisted fields are dropped.
- **Messages are scrubbed** for secret-like patterns (`api_key` / `secret` /
  `password` / `token` / `signature` / `Bearer …` / `github_pat_…` /
  credential-bearing URLs) and capped at 500 characters.
- **Stacks are included in development only.**
- **Alert emails contain identifiers and codes only** — no customer data,
  payment credentials, payloads or raw error text.
- Capture is best-effort and **never throws**: monitoring must never break
  the request path it is reporting on.

## Failure scenarios

- **SMTP down:** the alert email fails; the structured log line was already
  emitted, and one `payment-alert-delivery-failed` line is logged. The
  request/sweep continues normally.
- **SMTP unconfigured:** email is skipped silently; log lines still emitted.
- **Monitoring disabled (`ERROR_MONITORING_ENABLED=false`):** captures are
  no-ops. Use only deliberately — errors then surface only through raw
  process output.
- **Persistently failing worker:** each failed sweep alerts, but the
  per-kind+code throttle (default 15 min) bounds email volume; the heartbeat
  (`GET /api/health`) still reports the worker as `failing`.
- **Uncaught exception:** captured through `uncaughtExceptionMonitor` and
  the process exits with code 1 under Node.js default behaviour. The monitor
  only observes — it does not swallow, recover from, or change the exit
  behaviour of the exception, and no explicit `process.exit()` call exists.
  An unhandled promise rejection escalates to an uncaught exception under
  Node's default `--unhandled-rejections=throw` mode, so it is captured by
  the same monitor and the process still exits non-zero. Deliberately NOT
  used: a `process.on("unhandledRejection", …)` listener would suppress
  that escalation and let the app keep running in an unsafe state, and a
  `process.on("uncaughtException", …)` listener would replace the default
  termination behaviour. Verified by child-process tests in
  `tests/unit/process-error-monitoring.test.ts` (see Tests below).

## Tests

- `tests/unit/error-monitoring.test.ts` — config defaults, sanitisation and
  redaction, stack dev-only, non-allowlisted context dropped, disabled
  no-op, never-throws, alert throttle, email gating, SMTP-down and
  SMTP-unconfigured behaviour.
- `tests/unit/payment-alerts.test.ts` — `handleRoute` capture (500 still
  generic, auth errors not captured), worker `WORKER_FAILURE` alert, and the
  runner alert decisions (`alertOnBlockedInboxOutcomes`,
  `alertOnRefundReconciliationOutcomes`, `alertOnProviderFetchFailures`).
- `tests/unit/process-error-monitoring.test.ts` — child-process tests that
  run the real `src/instrumentation.ts` under plain Node.js (not Vitest):
  an unhandled rejection is captured and the process still exits 1, and an
  uncaught synchronous exception is captured and still terminates the
  process. The harness is `tests/helpers/process-error-harness.ts`.
- `tests/unit/webhook-route-alerts.test.ts` — webhook route alerts for
  receive failures, quarantined/conflicted events, blocked deliveries, and
  the no-alert cases (stored, duplicate, invalid input).
