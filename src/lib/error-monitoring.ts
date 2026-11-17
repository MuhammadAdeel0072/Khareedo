// Centralized server-side error monitoring.
//
// Design (chosen for this codebase — see docs/ERROR-MONITORING.md):
// - No vendor SDK is installed or configured (the only prior intent is the
//   "Sentry boundary" note in docs/REQUIREMENTS-TRACEABILITY.md, NFR-09), so
//   this module is vendor-neutral: every capture is sanitised, then emitted
//   as one structured JSON log line (any log aggregator can alert on it), and
//   critical payment alerts additionally go out by email through the existing
//   SMTP setup (src/services/email.service.ts). A Sentry transport can be
//   added later behind the same `captureError` / `capturePaymentAlert` calls.
// - Capture is best-effort and never throws: monitoring must never break the
//   request path it is reporting on.
//
// Safety rules (enforced by type + sanitisation, and covered by tests):
// - Context is an allowlist of identifier fields only. There is no way to
//   pass a payload, customer record, token or credential through context.
// - Error messages are scrubbed for secret-like patterns (keys, tokens,
//   passwords, signatures, bearer tokens, credential-bearing URLs) and
//   capped in length. Stacks are included in development only.
// - Alert emails contain identifiers and codes only — never payloads,
//   customer data, payment credentials or raw error text beyond the
//   sanitised message.
// - When credentials are absent (no alert email configured, or SMTP not
//   configured) the external alert is skipped silently; the structured log
//   line is still emitted so the failure is never silently dropped.
// - Alerts are throttled per kind+code so a persistently failing worker
//   sweep (every ~60s) cannot become an email storm.
import "server-only";

import {
  EmailDeliveryNotConfiguredError,
  sendAlertEmail,
} from "@/services/email.service";

export type PaymentAlertKind =
  | "PAYMENT_FAILURE"
  | "WEBHOOK_FAILURE"
  | "WORKER_FAILURE"
  | "RECONCILIATION_FAILURE";

/** Allowlisted context — identifiers and codes only. Never add payloads,
 * customer data, tokens, credentials or free-form text here. */
export type ErrorContext = {
  operation?: string;
  code?: string;
  requestId?: string;
  paymentId?: string;
  orderId?: string;
  eventId?: string;
  count?: number;
};

export type ErrorMonitoringConfig = {
  enabled: boolean;
  environment: string;
  alertEmailConfigured: boolean;
  alertThrottleMs: number;
};

const DEFAULT_ALERT_THROTTLE_MS = 15 * 60 * 1_000;
const MAX_MESSAGE_LENGTH = 500;
const MAX_NAME_LENGTH = 100;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // key=value style secrets: api_key=..., password: ..., "secret": "..."
  [
    /(api[_-]?key|secret|password|passwd|token|signature|credential|private[_-]?key)(\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    "$1$2[REDACTED]",
  ],
  [/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]+/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  // URLs carrying credentials: scheme://user:pass@host
  [/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/g, "[REDACTED-URL]"],
];

function sanitizeMessage(value: string): string {
  let scrubbed = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : scrubbed;
}

function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.$]/g, "");
  return cleaned.length > 0
    ? cleaned.slice(0, MAX_NAME_LENGTH)
    : "UnknownError";
}

function sanitizeCode(value: string | undefined): string {
  if (!value) return "UNKNOWN";
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "UNKNOWN";
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: sanitizeName(error.name || "Error"),
      message: sanitizeMessage(error.message || ""),
      stack: error.stack,
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: sanitizeMessage(error) };
  }
  return { name: "UnknownError", message: "Non-error value captured" };
}

export function getErrorMonitoringConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ErrorMonitoringConfig {
  const throttleRaw = Number(env.ERROR_MONITORING_ALERT_THROTTLE_MS);
  return {
    enabled: env.ERROR_MONITORING_ENABLED?.trim().toLowerCase() !== "false",
    environment:
      env.ERROR_MONITORING_ENVIRONMENT?.trim() ||
      env.NODE_ENV?.trim() ||
      "development",
    alertEmailConfigured: Boolean(env.ERROR_MONITORING_ALERT_EMAIL?.trim()),
    alertThrottleMs:
      Number.isSafeInteger(throttleRaw) && throttleRaw >= 0
        ? throttleRaw
        : DEFAULT_ALERT_THROTTLE_MS,
  };
}

type MonitoringEvent = {
  level: "error";
  type: "error" | "payment-alert";
  timestamp: string;
  environment: string;
  name?: string;
  message?: string;
  stack?: string;
  kind?: PaymentAlertKind;
  operation?: string;
  code?: string;
  requestId?: string;
  paymentId?: string;
  orderId?: string;
  eventId?: string;
  count?: number;
};

function baseEvent(
  type: MonitoringEvent["type"],
  config: ErrorMonitoringConfig,
  context: ErrorContext,
): MonitoringEvent {
  return {
    level: "error",
    type,
    timestamp: new Date().toISOString(),
    environment: config.environment,
    ...(context.operation ? { operation: context.operation } : {}),
    ...(context.code ? { code: sanitizeCode(context.code) } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.paymentId ? { paymentId: context.paymentId } : {}),
    ...(context.orderId ? { orderId: context.orderId } : {}),
    ...(context.eventId ? { eventId: context.eventId } : {}),
    ...(typeof context.count === "number" ? { count: context.count } : {}),
  };
}

/** Capture an unexpected server-side error. Emits one structured JSON log
 * line. Never throws. When monitoring is disabled, this is a no-op. */
export function captureError(error: unknown, context: ErrorContext = {}): void {
  try {
    const config = getErrorMonitoringConfig();
    if (!config.enabled) return;
    const described = describeError(error);
    const event: MonitoringEvent = {
      ...baseEvent("error", config, context),
      name: described.name,
      message: described.message,
    };
    // Stacks name files and line numbers, not secrets, but they are only
    // useful — and only included — in development.
    if (config.environment === "development" && described.stack) {
      event.stack = described.stack.slice(0, 4_000);
    }
    console.error(JSON.stringify(event));
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        type: "error-monitoring-failure",
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

// --- Payment alerts -------------------------------------------------------

const lastAlertSentAt = new Map<string, number>();

function alertKey(kind: PaymentAlertKind, code: string): string {
  return `${kind}:${code}`;
}

/** Test-only: clear the alert throttle so tests can re-trigger an alert. */
export function resetAlertThrottle(): void {
  lastAlertSentAt.clear();
}

function alertBody(kind: PaymentAlertKind, event: MonitoringEvent): string {
  const lines = [
    `Khareedo payment alert: ${kind}`,
    `Code: ${event.code ?? "UNKNOWN"}`,
    `Environment: ${event.environment}`,
    `Time: ${event.timestamp}`,
  ];
  if (event.operation) lines.push(`Operation: ${event.operation}`);
  if (event.paymentId) lines.push(`Payment ID: ${event.paymentId}`);
  if (event.orderId) lines.push(`Order ID: ${event.orderId}`);
  if (event.eventId) lines.push(`Event ID: ${event.eventId}`);
  if (typeof event.count === "number") lines.push(`Affected: ${event.count}`);
  if (event.message) lines.push(`Detail: ${event.message}`);
  lines.push(
    "",
    "This alert contains identifiers and codes only — no customer data,",
    "payment credentials or payloads. Investigate in the application logs",
    "and the admin payments tooling.",
  );
  return lines.join("\n");
}

async function sendAlertEmailIfConfigured(
  kind: PaymentAlertKind,
  event: MonitoringEvent,
  config: ErrorMonitoringConfig,
): Promise<void> {
  const recipient = process.env.ERROR_MONITORING_ALERT_EMAIL?.trim();
  if (!recipient) return;
  const key = alertKey(kind, event.code ?? "UNKNOWN");
  const now = Date.now();
  const lastSent = lastAlertSentAt.get(key);
  if (lastSent !== undefined && now - lastSent < config.alertThrottleMs) return;
  // Mark the attempt before sending so a failing mail host cannot retry
  // on every sweep and turn one failure into many.
  lastAlertSentAt.set(key, now);
  try {
    await sendAlertEmail({
      to: recipient,
      subject: `[Khareedo alert] ${kind} — ${event.code ?? "UNKNOWN"}`,
      text: alertBody(kind, event),
    });
  } catch (error) {
    if (error instanceof EmailDeliveryNotConfiguredError) return;
    console.error(
      JSON.stringify({
        level: "error",
        type: "payment-alert-delivery-failed",
        timestamp: new Date().toISOString(),
        environment: config.environment,
        kind,
        code: event.code ?? "UNKNOWN",
      }),
    );
  }
}

/** Capture a critical payment failure. Emits a structured log line and, when
 * an alert email is configured and SMTP is available, sends a throttled
 * email alert. Never throws. */
export function capturePaymentAlert(
  kind: PaymentAlertKind,
  context: ErrorContext = {},
): void {
  try {
    const config = getErrorMonitoringConfig();
    if (!config.enabled) return;
    const event: MonitoringEvent = {
      ...baseEvent("payment-alert", config, context),
      kind,
    };
    console.error(JSON.stringify(event));
    void sendAlertEmailIfConfigured(kind, event, config);
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        type: "error-monitoring-failure",
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
