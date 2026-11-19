// Simple in-memory rate limiter for sensitive operations (NFR-16).
// Sandbox scope: per-instance memory. Production note: swap for Redis/Upstash
// behind the same interface when running multiple instances.
import { isTrustedProxyConfigured } from "@/lib/trusted-proxy";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodically clean expired buckets to avoid unbounded growth
let lastSweep = Date.now();
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

/**
 * Check and consume one slot for `key`.
 * @returns true if allowed, false if rate limit exceeded.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } {
  sweep();
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { ok: true, retryAfterSec: 0 };
}

/**
 * Non-consuming check: would `key` be allowed right now? Reads the bucket
 * without consuming a slot, so callers that only count failures (for
 * example the login limiter) can test the budget before doing expensive
 * work and record a hit only when the attempt actually fails.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterSec: number } {
  sweep();
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) return { ok: true, retryAfterSec: 0 };
  if (bucket.count >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfterSec: 0 };
}

export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Best-effort client IP for rate limiting and audit logging.
 *
 * Forwarded headers (`X-Forwarded-For`, `X-Real-IP`) are trusted ONLY when
 * a trusted proxy is configured (TRUSTED_PROXY_IPS — see
 * src/lib/trusted-proxy.ts). When no trusted proxy is configured, forwarded
 * headers are ignored entirely and this returns "unknown": per-IP limits
 * then share one global bucket. That is fail-safe — an attacker who can
 * reach the app directly cannot evade a limit by spoofing a header; they
 * can only share the bucket. It is NOT robust per-IP protection until the
 * deployment names its proxy (Q-01); see docs/DEPLOYMENT.md.
 *
 * Accepts a `Headers` instance (route handlers) or a plain header record
 * (NextAuth's `authorize` receives `req.headers` as a record).
 */
export function clientIp(headers: HeaderSource): string {
  if (!isTrustedProxyConfigured()) return "unknown";
  return (
    readHeader(headers, "x-forwarded-for")?.split(",")[0]?.trim() ||
    readHeader(headers, "x-real-ip")?.trim() ||
    "unknown"
  );
}
