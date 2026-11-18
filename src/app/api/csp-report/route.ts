// CSP violation report endpoint — POST /api/csp-report.
//
// Receives the reports browsers send for Content-Security-Policy-Report-Only
// violations (see src/lib/security-headers.ts, report-uri directive).
//
// Safety design — a reporting endpoint is an unauthenticated POST that
// accepts attacker-influenced input, so it is deliberately boring:
// - Rate-limited (30 reports/min per IP) using the existing in-memory
//   limiter, so it cannot be used to flood the logs.
// - Body capped at 8 KiB (bounded streaming read); oversized bodies are
//   dropped silently with a 204.
// - Only a small allowlist of fields is ever logged, and URLs are reduced
//   to their origin: full document/blocked URLs can carry query strings
//   with order references or tokens, and must never reach the logs.
// - Logs one structured console.warn line per valid report. Violations are
//   NOT errors: they never go through captureError and never send alerts.
// - Always answers 204 (429 when rate-limited). Invalid reports are
//   dropped silently — a reporting endpoint must not leak validation
//   detail or invite retries.
//
// The endpoint is public by design: browsers send reports without
// credentials, and there is nothing to authenticate.

import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BYTES = 8 * 1024;
const RATE_LIMIT_PER_MINUTE = 30;

export type CspReportSummary = {
  /** Origin of the page the violation happened on, or "unknown". */
  documentOrigin: string;
  /** Directive that was violated, e.g. "img-src", or "unknown". */
  violatedDirective: string;
  /** Origin of the blocked resource, "inline", "eval", "data", "blob", or "unknown". */
  blockedOrigin: string;
};

const DIRECTIVE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Reduces a URL string to its origin, or returns `fallback` when unparsable. */
function toOrigin(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  try {
    return new URL(value).origin;
  } catch {
    return fallback;
  }
}

/**
 * Validates a parsed report body and extracts the allowlisted summary.
 * Accepts only the classic `{"csp-report": {...}}` shape browsers send.
 * Returns null for anything else — including non-objects, missing
 * csp-report, and reports without a violated directive.
 */
export function parseCspReport(body: unknown): CspReportSummary | null {
  if (typeof body !== "object" || body === null) return null;
  const report = (body as Record<string, unknown>)["csp-report"];
  if (typeof report !== "object" || report === null) return null;
  const fields = report as Record<string, unknown>;

  const violatedDirective =
    typeof fields["violated-directive"] === "string" &&
    DIRECTIVE_PATTERN.test(fields["violated-directive"])
      ? fields["violated-directive"]
      : null;
  if (violatedDirective === null) return null;

  const blockedRaw = fields["blocked-uri"];
  let blockedOrigin: string;
  if (
    blockedRaw === "inline" ||
    blockedRaw === "eval" ||
    blockedRaw === "data" ||
    blockedRaw === "blob"
  ) {
    blockedOrigin = blockedRaw;
  } else if (typeof blockedRaw === "string" && blockedRaw.length > 0) {
    blockedOrigin = toOrigin(blockedRaw, "unknown");
  } else {
    blockedOrigin = "unknown";
  }

  return {
    documentOrigin: toOrigin(fields["document-uri"], "unknown"),
    violatedDirective,
    blockedOrigin,
  };
}

/**
 * Reads the request body as text with a hard byte cap. Returns null when
 * the body exceeds the cap (the stream is cancelled) or cannot be read.
 */
async function readBoundedText(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) break;
      total += value.byteLength;
      if (total > MAX_REPORT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function POST(request: Request) {
  const limit = rateLimit(
    `csp-report:${clientIp(request.headers)}`,
    RATE_LIMIT_PER_MINUTE,
    60_000,
  );
  if (!limit.ok) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSec) },
    });
  }

  const text = await readBoundedText(request);
  if (text === null) return new Response(null, { status: 204 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 204 });
  }
  const summary = parseCspReport(body);
  if (summary !== null) {
    console.warn(JSON.stringify({ type: "csp-report", ...summary }));
  }
  return new Response(null, { status: 204 });
}
