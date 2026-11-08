// Derives the public origin of the current request from proxy headers, so
// authentication and payment return URLs follow the host the visitor actually
// uses (localhost dev, platform preview proxies, production) without hardcoding
// any hostname. Explicit environment configuration still wins where callers
// prefer a pinned origin; this derivation is the request-scoped fallback.
export function requestOrigin(headers: Headers): string | null {
  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!forwardedHost) return null;
  const host = forwardedHost.split(",")[0].trim();
  if (!host || host.length > 253 || /[\s\u0000-\u001f\u007f]/.test(host)) return null;

  const forwardedProto = headers.get("x-forwarded-proto");
  const proto = forwardedProto === null
    ? "http" // Direct (unproxied) request — plain HTTP unless a proxy says otherwise.
    : forwardedProto.split(",")[0].trim().toLowerCase();
  if (proto !== "http" && proto !== "https") return null;

  return `${proto}://${host}`;
}
