// CSP violation report endpoint — POST /api/csp-report.
//
// Receives the reports browsers send for Content-Security-Policy-Report-Only
// violations (see src/lib/security-headers.ts, report-uri directive).
//
// Safety design — a reporting endpoint is an unauthenticated POST that
// accepts attacker-influenced input, so it is deliberately boring:
// - Two-tier rate limiting using the existing in-memory limiter (see POST
//   below): a per-IP bucket (30/min, best effort — see the trust note) plus
//   a global bucket (300/min) that no spoofed header can bypass. Together
//   they bound log volume even under a spoofed-header flood.
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
/**
 * Rate limits for POST /api/csp-report (reports per rolling 60s window).
 *
 * `CSP_REPORT_PER_IP_LIMIT` — per-IP bucket, best effort only. `clientIp()`
 * trusts the first `X-Forwarded-For` entry, and that header is
 * client-controlled unless a trusted proxy overwrites it. The repo's
 * `Caddyfile` does overwrite it (`header_up X-Forwarded-For {remote_host}`),
 * but nothing in the repo establishes that this Caddyfile is the production
 * proxy, or that the Next.js server on :3000 is not directly reachable — see
 * docs/SECURITY-HEADERS.md. So a spoofed header can rotate the per-IP
 * bucket, and this limit is NOT claimed as robust per-IP protection.
 *
 * `CSP_REPORT_GLOBAL_LIMIT` — the real bound. Keyed on nothing
 * attacker-controlled, so no spoofed header can bypass it: at most 300
 * reports per minute per process reach the logs, whatever the headers say.
 * 300/min is generous for a reporting channel whose job is policy tuning
 * (a well-tuned policy should produce near-zero reports), and small enough
 * to keep log volume bounded under attack.
 *
 * Both buckets are in-memory and per-process (src/lib/rate-limit.ts): under
 * a multi-instance deployment each instance enforces its own cap, so the
 * effective global cap is N x the configured value. That matches the
 * current single-instance deployment assumption.
 */
export const CSP_REPORT_PER_IP_LIMIT = 30;
export const CSP_REPORT_GLOBAL_LIMIT = 300;

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
  // Global bucket FIRST (the spoof-proof bound), then the per-IP bucket.
  // The order matters: after the global cap is reached, a request must be
  // rejected here without ever calling clientIp() or touching a per-IP
  // bucket — otherwise a flood of rotating spoofed IPs would keep creating
  // new per-IP entries in the in-memory Map even though every request is
  // rejected. Either bucket tripped answers 429.
  const global = rateLimit(
    "csp-report:global",
    CSP_REPORT_GLOBAL_LIMIT,
    60_000,
  );
  if (!global.ok) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(global.retryAfterSec) },
    });
  }
  const perIp = rateLimit(
    `csp-report:${clientIp(request.headers)}`,
    CSP_REPORT_PER_IP_LIMIT,
    60_000,
  );
  if (!perIp.ok) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(perIp.retryAfterSec) },
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
