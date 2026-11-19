// Derives the public origin of the current request from proxy headers, so
// authentication and payment return URLs follow the host the visitor actually
// uses (localhost dev, platform preview proxies, production) without hardcoding
// any hostname. Explicit environment configuration still wins where callers
// prefer a pinned origin; this derivation is the request-scoped fallback.
//
// Trust rule (Phase 2, area G): forwarded headers (`X-Forwarded-Host`,
// `X-Forwarded-Proto`) are honoured ONLY when a trusted proxy is configured
// (TRUSTED_PROXY_IPS — see src/lib/trusted-proxy.ts). Without one, the
// `Host` header alone is used with plain `http`: a client that reaches the
// app directly cannot make the app believe it is on another host or scheme.
// Callers that need a fixed production origin must pin it with
// SAFEPAY_SITE_ORIGIN / NEXTAUTH_URL instead of relying on this fallback.
import { isTrustedProxyConfigured } from "@/lib/trusted-proxy";

export function requestOrigin(headers: Headers): string | null {
  const trusted = isTrustedProxyConfigured();
  const forwardedHost = trusted ? headers.get("x-forwarded-host") : null;
  const hostHeader = forwardedHost ?? headers.get("host");
  if (!hostHeader) return null;
  const host = hostHeader.split(",")[0].trim();
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f]/.test(host)) return null;

  const forwardedProto = trusted ? headers.get("x-forwarded-proto") : null;
  const proto = forwardedProto === null
    ? "http" // Direct (unproxied) request — plain HTTP unless a trusted proxy says otherwise.
    : forwardedProto.split(",")[0].trim().toLowerCase();
  if (proto !== "http" && proto !== "https") return null;

  return `${proto}://${host}`;
}
