# Security response headers and report-only CSP

Khareedo sends a standard set of HTTP security headers on every response
and a **report-only** Content Security Policy. CSP is deliberately not
enforced yet: this PR collects violation reports for one release so the
policy can be tightened from evidence instead of breaking the storefront
on a guess.

## Where headers are set

Exactly one place: `next.config.ts` `headers()`, built by
`src/lib/security-headers.ts` (`buildSecurityHeaders`). The `/:path*`
source covers every response Next.js serves — pages, API routes and
static assets. `src/proxy.ts` does **not** set headers: its matcher only
covers `/admin` and `/account`, and extending it would run the auth
middleware on every request for no benefit.

One subtlety, verified against the live built server: **`next.config.ts`
headers override a route handler's own header of the same name.** The
three Safepay responses deliberately pin `Referrer-Policy: no-referrer`
on their own responses, so `next.config.ts` carries two more specific
rules (`/api/checkout/safepay/:path*`, `/api/webhooks/safepay`) that
re-pin `no-referrer` — otherwise the global
`strict-origin-when-cross-origin` would silently weaken them. The
route-level headers stay in place as defence in depth. Any future route
that returns `HostedCheckoutRedirect.response()` (the 303 to Safepay)
must be added to that pinned list for the same reason.

## Headers sent

| Header | Value | Notes |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | Blocks MIME sniffing. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Same-origin referrer in full; cross-origin only the origin. The Safepay routes (`/api/checkout/safepay/*`, `/api/webhooks/safepay`) are pinned to the stricter `no-referrer` by more specific `next.config.ts` rules — see "Where headers are set". |
| `X-Frame-Options` | `DENY` | Legacy-browser companion to CSP `frame-ancestors 'none'`. |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` | Disables sensor/payment APIs the store never uses. `payment=()` disables the Payment Request API; Safepay checkout is a top-level redirect, not Payment Request, so it is unaffected. |
| `Strict-Transport-Security` | `max-age=63072000` | **Production builds only** (`NODE_ENV === "production"` at build time). No `includeSubDomains` — subdomain TLS posture is unknown — and no `preload`, because the domain is not submitted to the HSTS preload list. Browsers ignore HSTS over plain HTTP, so dev/preview servers are unaffected. |
| `Content-Security-Policy-Report-Only` | see below | Violations are reported, never blocked. |
| `Content-Security-Policy` | — | **Never sent.** Enforcing CSP is a follow-up PR after the report-only window. |

## Report-only CSP directives

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Deny everything not explicitly allowed. |
| `script-src` | `'self' 'unsafe-inline'` | Next.js emits inline scripts for hydration and routing. No third-party scripts are loaded. Removing `unsafe-inline` needs a nonce setup — a later PR, not this one. |
| `style-src` | `'self' 'unsafe-inline'` | Next.js/Tailwind inject inline `<style>` for critical CSS. No external stylesheets are loaded. |
| `img-src` | `'self' data: https://evsxjmtireufyymgsehx.supabase.co https://i5.walmartimages.com` | Product images come from Supabase Storage and the Walmart CDN (the same hosts as `images.remotePatterns` in `next.config.ts` — keep them in sync). `data:` is for Next.js blur placeholders. |
| `font-src` | `'self'` | Plus Jakarta Sans and Geist Mono are self-hosted via `next/font`; no webfont CDN. |
| `connect-src` | `'self'` | Every browser fetch/XHR is same-origin (Next.js API routes). Supabase and Safepay are called server-side only — the browser never talks to them directly. |
| `frame-src` | `'none'` | No iframes anywhere. Safepay checkout is a top-level navigation (`window.location.assign` to `sandbox.api.getsafepay.com/embedded/`), not an embed. |
| `frame-ancestors` | `'none'` | The store must never be framed (clickjacking). |
| `object-src` | `'none'` | No plugins or embeds. |
| `base-uri` | `'self'` | No `<base>` injection. |
| `form-action` | `'self'` | Checkout posts to same-origin APIs and navigates with `location.assign`; no form posts to another origin. |
| `worker-src` | `'none'` | No service workers are registered. |
| `report-uri` | `/api/csp-report` | Violation reports go to the endpoint below. |

Deliberately absent: `unsafe-eval` (production Next.js does not need it)
and any wildcard. In development, Next.js HMR may generate `eval`
violation reports — expected noise; report-only means nothing is blocked.

## Violation reporting — POST /api/csp-report

Browsers POST violation reports to this endpoint (see
`src/app/api/csp-report/route.ts`). It is public by design: browsers send
reports without credentials.

Safety rules, all tested (`tests/unit/csp-report-route.test.ts`):

- **Rate-limited:** 30 reports/minute per IP via the existing in-memory
  limiter (`src/lib/rate-limit.ts`); excess answers 429 with `Retry-After`.
- **Body capped at 8 KiB:** oversized bodies are dropped silently (204).
- **Only allowlisted fields are logged:** `document-uri` and `blocked-uri`
  are reduced to their origin; `violated-directive` must match a strict
  pattern. Full URLs never reach the logs — they can carry query strings
  with order references or tokens.
- **Reports are not errors:** one structured `console.warn` line per valid
  report. Violations never go through `captureError` and never send email
  alerts.
- **Always 204** (429 when rate-limited). Invalid reports are dropped
  silently.

To review reports, search server logs for `"type":"csp-report"`. A report
means a resource *would have been blocked* under an enforcing policy —
during the report-only window, nothing is actually blocked.

## Development vs production

| | Development (`next dev`) | Production (`next build` + `next start`) |
| --- | --- | --- |
| All headers except HSTS | Sent | Sent |
| HSTS | Not sent | Sent, `max-age=63072000` |
| CSP | Report-only | Report-only |
| HMR `eval` reports | Possible noise in the report log | None — production bundles do not use `eval` |

## Tests

- `tests/unit/security-headers.test.ts` — header set in dev/prod, HSTS
  gating and exact value, no enforcing CSP header ever, every CSP
  directive, no `unsafe-eval`/wildcards, the Safepay `no-referrer`
  pinning, and `next.config.ts` wiring.
- `tests/unit/csp-report-route.test.ts` — report parsing (origins only,
  `inline`/`eval` preserved, malformed input rejected), 204 behaviour,
  oversized-body drop, per-IP rate limiting, no query-string leakage.
- `tests/e2e/security-headers.spec.ts` — live header assertions on the
  storefront, `/api/health`, a static asset, the Safepay session route's
  preserved `no-referrer`, and a 204 from the report endpoint. Needs a
  running app; not run in the sandbox.

## Known limitations and follow-ups

- **CSP is report-only.** Nothing is enforced. After at least one release
  of reports with no unexpected violations, a follow-up PR can switch the
  same directives to an enforcing `Content-Security-Policy` header
  (keeping report-only alongside it during the transition).
- **HSTS is not preloaded and has no `includeSubDomains`.** Add
  `includeSubDomains` only after confirming every subdomain serves HTTPS;
  add `preload` only if the domain is submitted to the preload list.
- **No `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`.**
  COOP/COEP need a popup and cross-origin-embedding audit (notably the
  Safepay redirect return flow); deferred, not forgotten.
- **Caddy is untouched.** The deployment proxy (`Caddyfile`) must preserve
  these headers rather than stripping or overriding them; verify on the
  deployment path, not just in `next start`.
- **Report volume is only visible in server logs.** There is no dashboard
  or alerting for CSP reports by design — alerting on violations would
  spam operators during the observation window.
- **`unsafe-inline` remains in `script-src`/`style-src`.** Removing it
  needs Next.js nonce support wired through the proxy/middleware; that is
  a separate change with its own testing.
