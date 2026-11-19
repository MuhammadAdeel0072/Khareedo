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

Safety rules, all tested (`tests/unit/csp-report-route.test.ts`,
`tests/unit/csp-report-spoof.test.ts`):

- **Two-tier rate limiting** via the existing in-memory limiter
  (`src/lib/rate-limit.ts`); either tier tripped answers 429 with
  `Retry-After`:
  - *Per-IP bucket (30/min, best effort):* fairness between honest
    clients. It is **not** robust per-IP protection — see the trust model
    below.
  - *Global bucket (300/min, the real bound):* keyed on nothing
    attacker-controlled, so no spoofed header can bypass it. At most 300
    reports per minute per process reach the logs, whatever the headers
    say — generous for a tuning channel (a well-tuned policy should
    produce near-zero reports), small enough to bound log volume under
    attack.
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

### Trust model for forwarded IPs (reviewed 2026-11-18; fixed 2026-11-19, Phase 2)

The per-IP bucket keys on `clientIp()` (`src/lib/rate-limit.ts`). Before
Phase 2 it trusted the first `X-Forwarded-For` entry unconditionally —
client-controlled unless a trusted proxy overwrote it. That is fixed:
`clientIp()` now honours forwarded headers **only when
`TRUSTED_PROXY_IPS` is configured** (`src/lib/trusted-proxy.ts`); without
it, every client is reported as `"unknown"` and all requests share one
bucket. A spoofed header can therefore no longer buy a fresh bucket — it
cannot even get past the per-IP cap (`tests/unit/csp-report-spoof.test.ts`
now covers both the trusted-proxy case and the untrusted fail-safe).

What still needs the deployment decision (Q-01):

- **What the proxy does:** the repo's `Caddyfile` sets
  `header_up X-Forwarded-For {remote_host}` on both handlers. In Caddy,
  that *replaces* the incoming header with the connecting client's IP
  (Caddy's default is to append, which would pass a spoofed value
  through); a client-supplied value cannot survive this Caddyfile.
- **Why that is not enough to trust it yet:** the `Caddyfile` dates from the
  initial project checkpoint, listens on plain HTTP `:81`, and nothing in
  the repo says it is the production proxy — there is no Dockerfile,
  compose file, or deployment guide naming it, and no firewall rule
  showing port 3000 is not directly reachable. The production start
  command (`bun .next/standalone/server.js`) binds the Next.js server to
  all interfaces by default, so on an unprotected host an attacker could
  bypass Caddy entirely and send any `X-Forwarded-For` they like straight
  to the app.
- **Consequence until the proxy is named and `TRUSTED_PROXY_IPS` is set:**
  per-IP limits work, but as one shared `"unknown"` bucket — a fairness
  mechanism, not per-client protection. The global bucket remains the
  protection for this endpoint, and the spoof tests prove it: rotating
  the claimed IP on every request still stops at 300 reports/min
  (`tests/unit/csp-report-spoof.test.ts`). Once the production proxy is
  named and its IPs are put in `TRUSTED_PROXY_IPS`, per-IP buckets become
  real per-client buckets. See `docs/DEPLOYMENT.md` ("Production
  security configuration").
- **Same caveat, wider scope:** `clientIp()` is shared by the register,
  checkout, Safepay session, resend-verification and admin image-import
  routes — their per-IP limits are equally shared-bucket until the proxy
  is configured.
- **Per-process limits:** both buckets live in a module-level `Map` in
  the server process. That matches the current single-instance deployment
  assumption. Under a multi-instance deployment each instance enforces its
  own cap, so the effective global cap is N x the configured value. No
  Redis or other shared store is introduced by this PR.

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
- `tests/unit/csp-report-spoof.test.ts` — spoofed `X-Forwarded-For`
  headers: a single spoofed IP still hits the per-IP cap, rotating
  spoofed IPs stop at the global cap (300/min), and a multi-value
  `X-Forwarded-For` is keyed on its first entry.
- `tests/e2e/security-headers.spec.ts` — live header assertions on the
  storefront, `/api/health`, a static asset, the Safepay session route's
  preserved `no-referrer`, and a 204 from the report endpoint. Needs a
  running app; not run in the sandbox.

## Known limitations and follow-ups

- **CSP is report-only.** Nothing is enforced. After at least one release
  of reports with no unexpected violations, a follow-up PR can switch the
  same directives to an enforcing `Content-Security-Policy` header
  (keeping report-only alongside it during the transition). This was
  re-confirmed as a deliberate decision in Phase 2 (not a missed bug):
  enforcement could break legitimate functionality, and the report
  window has not run yet.
- **HSTS is not preloaded and has no `includeSubDomains`.** Add
  `includeSubDomains` only after confirming every subdomain serves HTTPS;
  add `preload` only if the domain is submitted to the preload list.
- **No `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`.**
  COOP/COEP need a popup and cross-origin-embedding audit (notably the
  Safepay redirect return flow); deferred, not forgotten.
- **Caddy is untouched.** The deployment proxy (`Caddyfile`) must preserve
  these headers rather than stripping or overriding them; verify on the
  deployment path, not just in `next start`. The same proxy question
  decides whether `X-Forwarded-For` can be trusted at all — see the trust
  model in the reporting section above.
- **Per-IP rate limiting is best effort, per process, and shared-bucket
  until the proxy is configured.** Both buckets of the CSP report endpoint
  (and every other `clientIp()`-based limit in the app) collapse into one
  `"unknown"` bucket while `TRUSTED_PROXY_IPS` is unset, and are enforced
  separately by each server process under multi-instance deployment.
- **Report volume is only visible in server logs.** There is no dashboard
  or alerting for CSP reports by design — alerting on violations would
  spam operators during the observation window.
- **`unsafe-inline` remains in `script-src`/`style-src`.** Removing it
  needs Next.js nonce support wired through the proxy/middleware; that is
  a separate change with its own testing.
- **`X-Powered-By` is disabled** (`poweredByHeader: false` in
  `next.config.ts`, Phase 2) so responses do not advertise the framework
  version.
- **CSRF is enforced in the proxy, not by headers.** Same-origin
  validation for state-changing API requests lives in `src/proxy.ts`
  (rules in `src/lib/csrf.ts`); see `docs/REQUIREMENTS-TRACEABILITY.md`.
  SameSite=Lax cookies remain the first layer.
