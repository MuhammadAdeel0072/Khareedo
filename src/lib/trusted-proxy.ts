// Trusted-proxy configuration (Phase 2, area G).
//
// `clientIp()` and `requestOrigin()` both derive security-relevant values
// from proxy headers (`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`,
// `X-Forwarded-Proto`). Those headers are client-controlled unless a proxy
// the operator trusts overwrites them — so they are trusted ONLY when the
// deployment declares a trusted proxy.
//
// Set TRUSTED_PROXY_IPS to the comma-separated IPs of the proxies in front
// of the app (for example the Caddyfile host, which overwrites
// X-Forwarded-For with the real client IP:
// `header_up X-Forwarded-For {remote_host}`). The proxy MUST overwrite the
// forwarded headers with the real client values; a proxy that merely
// appends to them leaves the first entry attacker-controlled.
//
// Honest limitation: Next.js route handlers cannot see the TCP peer IP, so
// this is an operator assertion, not a runtime peer check — the app cannot
// verify that the request actually came through a listed proxy. When the
// variable is unset, forwarded headers are ignored entirely and the client
// IP is reported as "unknown" (per-IP rate limits then share one global
// bucket, which is fail-safe: an attacker cannot evade the limit by
// spoofing a header, they can only share the bucket with everyone else).
// See docs/DEPLOYMENT.md for the deployment requirements.
export function trustedProxyIps(): string[] {
  return (process.env.TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** True when the operator has asserted a trusted proxy is in front. */
export function isTrustedProxyConfigured(): boolean {
  return trustedProxyIps().length > 0;
}
