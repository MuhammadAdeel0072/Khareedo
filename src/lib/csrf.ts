// CSRF protection for state-changing API requests (Phase 2, area C).
//
// The app's cookies are SameSite=Lax, which blocks most cross-site POSTs,
// but SameSite is a single layer: a same-site (different-origin) page, a
// Lax bypass via a top-level GET, or a browser that does not enforce
// SameSite would still reach the API with the victim's cookies. This module
// adds an explicit same-origin check on the Origin/Referer headers for
// POST, PUT, PATCH and DELETE requests under /api/*.
//
// The check is deliberately pure (Web APIs only) so it can run in the edge
// proxy (src/proxy.ts) as well as in unit tests without a Node runtime.
//
// Rules:
// - Expected origins: the request URL's own origin, plus the NEXTAUTH_URL
//   origin when set. A cross-site attacker's Origin can never equal either
//   of the app's own origins, so the check is sound for the browser threat
//   model; accepting both keeps preview deployments working when
//   NEXTAUTH_URL still points at localhost (see expectedOrigins).
// - If Origin is present and matches neither expected origin -> reject.
// - Else if Origin is absent, the Referer origin is checked the same way;
//   a malformed Referer -> reject.
// - If BOTH are absent -> allow. Non-browser clients (curl, server-to-
//   server calls, the external maintenance cron) send neither header, and
//   blocking them would break legitimate automation. A browser always
//   sends Origin on a same-origin POST (and Referer on most requests), so
//   a real CSRF attempt cannot hide behind "both absent".
// - GET/HEAD/OPTIONS are never checked: they must not change state, and
//   the Safepay return page is a GET that triggers server-side payment
//   verification (do not break it).
//
// Exemptions (exact paths / prefixes, checked before the origin check):
// - /api/webhooks/safepay — Safepay posts cross-origin; its own HMAC
//   signature is the authentication for that route.
// - /api/csp-report — browser violation reports; rate-limited globally.
// - The NextAuth handler ONLY (src/app/api/auth/[...nextauth]) — NextAuth
//   validates its own CSRF token on its sign-in flows (including the
//   Google OAuth callback, which is a GET anyway). The exemption is the
//   handler's exact paths plus its two provider-segmented prefixes, never
//   a broad /api/auth/ prefix: the application's own endpoints under
//   /api/auth/* — /api/auth/forgot-password, /api/auth/reset-password and
//   /api/auth/resend-verification — are NOT exempt and are CSRF-checked
//   like any other API route. A future custom route under /api/auth/*
//   is therefore protected by default; only a real NextAuth path is added
//   here, deliberately, if the handler ever grows one.
import type { NextRequest } from "next/server";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const CSRF_EXEMPT_PATHS = ["/api/webhooks/safepay", "/api/csp-report"] as const;

// Exact paths served by the NextAuth handler (src/app/api/auth/[...nextauth]).
// Most are GET-only in practice (session, csrf, providers, error,
// verify-request); signin/signout are the handler's pages. Listed exactly —
// never as a prefix — so a future custom route under /api/auth/* is
// CSRF-checked by default.
const NEXTAUTH_EXEMPT_PATHS = [
  "/api/auth/session",
  "/api/auth/csrf",
  "/api/auth/providers",
  "/api/auth/error",
  "/api/auth/verify-request",
  "/api/auth/signin",
  "/api/auth/signout",
] as const;

// Provider-segmented paths served by the NextAuth handler: the credentials
// sign-in POST goes to /api/auth/callback/<provider>, OAuth providers
// redirect back there, and /api/auth/signin/<provider> serves a provider's
// sign-in page. NextAuth validates its own CSRF token on these flows.
const NEXTAUTH_EXEMPT_PREFIXES = ["/api/auth/callback/", "/api/auth/signin/"] as const;

export function isCsrfExemptPath(pathname: string): boolean {
  if ((CSRF_EXEMPT_PATHS as readonly string[]).includes(pathname)) return true;
  if ((NEXTAUTH_EXEMPT_PATHS as readonly string[]).includes(pathname)) return true;
  return NEXTAUTH_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The origins a same-origin request may carry. */
export function expectedOrigins(request: { url: string }, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>([new URL(request.url).origin]);
  // The pinned NEXTAUTH_URL origin is accepted too: in a preview deployment
  // NEXTAUTH_URL may still point at localhost while the app is served from
  // a preview URL, and a request from either origin is a request from this
  // app. An attacker's origin matches neither, so accepting both does not
  // weaken the check — the browser always sends the page's real origin.
  const pinned = env.NEXTAUTH_URL;
  if (pinned) {
    try {
      origins.add(new URL(pinned).origin);
    } catch {
      // A malformed NEXTAUTH_URL pins nothing; the request origin still applies.
    }
  }
  return origins;
}

/**
 * True when the request is a same-origin state-changing API request (or a
 * request that needs no check: a safe method, an exempt path, or a request
 * carrying neither Origin nor Referer). False only when an Origin/Referer
 * header is present and proves the request came from another origin.
 */
export function isSameOriginRequest(
  request: { method: string; url: string; headers: Headers },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return true;
  const expected = expectedOrigins(request, env);
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const originValue = originOf(origin);
    return originValue !== null && expected.has(originValue);
  }
  const referer = request.headers.get("referer");
  if (referer !== null) {
    const refererValue = originOf(referer);
    return refererValue !== null && expected.has(refererValue);
  }
  return true;
}

/** The proxy-facing check: does this request need a CSRF rejection? */
export function isCsrfRejected(request: NextRequest, env: NodeJS.ProcessEnv = process.env): boolean {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api/")) return false;
  if (isCsrfExemptPath(pathname)) return false;
  return !isSameOriginRequest(request, env);
}
