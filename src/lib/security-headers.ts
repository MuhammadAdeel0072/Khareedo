// Security response headers and report-only Content Security Policy.
//
// Single source of truth for every HTTP security header Khareedo sends.
// Wired in exactly one place: `next.config.ts` `headers()`, which applies
// them to every response Next.js serves (pages, API routes, static assets).
// `src/proxy.ts` deliberately does NOT set headers: its matcher only covers
// /admin and /account, and extending it would run the auth middleware on
// every request for no benefit.
//
// Rules for changing this file:
// - Never add an enforcing `Content-Security-Policy` header here. CSP stays
//   report-only until a later PR enforces it after reviewing the reports
//   collected at /api/csp-report (see docs/SECURITY-HEADERS.md).
// - Every directive must be justified by an actual application requirement
//   (see the comments below). No wildcards, no `unsafe-eval`.
// - `unsafe-inline` in script-src/style-src is the documented Next.js
//   exception: the framework emits inline scripts for hydration/routing and
//   inline styles for critical CSS. Removing it requires a nonce setup.
// - Image hosts must stay in sync with `images.remotePatterns` in
//   next.config.ts: a host allowed to load via next/image must also be
//   allowed by img-src, or browsers will report (not block) it.
// - HSTS is production-only. It is baked into the build by next.config.ts,
//   and browsers only honour it over HTTPS, so dev/preview servers over
//   plain HTTP are unaffected.

export type SecurityHeader = { key: string; value: string };

/** Strict-Transport-Security: 2 years. No includeSubDomains (subdomain TLS
 *  posture is unknown) and no preload (the domain is not submitted to the
 *  HSTS preload list). Both are deliberate omissions, not oversights. */
export const HSTS_HEADER_VALUE = "max-age=63072000";

/** Where browsers send CSP violation reports (POST, see
 *  src/app/api/csp-report/route.ts). */
export const CSP_REPORT_URI = "/api/csp-report";

/** Remote image hosts the storefront actually loads, mirroring
 *  `images.remotePatterns` in next.config.ts. */
export const CSP_IMAGE_HOSTS = [
  "https://evsxjmtireufyymgsehx.supabase.co",
  "https://i5.walmartimages.com",
] as const;

/**
 * Report-only CSP directives, in emission order. Each entry is
 * [directive, value]. Justifications:
 *
 * - default-src 'self': deny everything not explicitly allowed below.
 * - script-src 'self' 'unsafe-inline': Next.js emits inline scripts for
 *   hydration and routing. No third-party scripts are loaded anywhere.
 * - style-src 'self' 'unsafe-inline': Next.js/Tailwind inject inline
 *   <style> for critical CSS. No external stylesheets are loaded.
 * - img-src 'self' data: <hosts>: product images come from Supabase
 *   Storage and the Walmart CDN (see remotePatterns); data: is for
 *   Next.js blur placeholders. No other image origin is used.
 * - font-src 'self': Plus Jakarta Sans and Geist Mono are self-hosted via
 *   next/font; no webfont CDN is used.
 * - connect-src 'self': every fetch/XHR the browser makes is same-origin
 *   (Next.js API routes). Supabase and Safepay are called server-side
 *   only — the browser never talks to them directly.
 * - frame-src 'none': the app renders no iframes. Safepay checkout is a
 *   top-level navigation (window.location.assign), not an embed, so it
 *   needs no frame allowance.
 * - frame-ancestors 'none': the store must never be framed (clickjacking).
 *   X-Frame-Options: DENY below is the legacy-browser companion.
 * - object-src 'none': no plugins/embeds.
 * - base-uri 'self': no <base> injection.
 * - form-action 'self': checkout posts to same-origin APIs and navigates
 *   with location.assign; no form posts to another origin.
 * - worker-src 'none': no service workers are registered.
 * - report-uri: violation reports go to the CSP report endpoint.
 *
 * Deliberately absent: `unsafe-eval` (production Next.js does not need
 * it; dev HMR may generate eval reports in development — expected noise,
 * and report-only means nothing is blocked) and any wildcard.
 */
export const REPORT_ONLY_CSP_DIRECTIVES: ReadonlyArray<
  readonly [string, string]
> = [
  ["default-src", "'self'"],
  ["script-src", "'self' 'unsafe-inline'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", `'self' data: ${CSP_IMAGE_HOSTS.join(" ")}`],
  ["font-src", "'self'"],
  ["connect-src", "'self'"],
  ["frame-src", "'none'"],
  ["frame-ancestors", "'none'"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'self'"],
  ["worker-src", "'none'"],
  ["report-uri", CSP_REPORT_URI],
] as const;

/** Serialises the report-only CSP directives into a single header value. */
export function buildReportOnlyCsp(): string {
  return REPORT_ONLY_CSP_DIRECTIVES.map(([name, value]) => `${name} ${value}`).join("; ");
}

/**
 * Builds the full security-header set for one response.
 *
 * @param isProduction - true only for production builds (next.config.ts
 *   passes `process.env.NODE_ENV === "production"`). HSTS is omitted
 *   otherwise: it is meaningless over plain HTTP and must never be baked
 *   into a development server's responses.
 * @param referrerPolicy - override for routes that deliberately pin a
 *   stricter policy (the Safepay routes pin `no-referrer`; see
 *   next.config.ts). Defaults to `strict-origin-when-cross-origin`.
 *
 * The enforcing `Content-Security-Policy` header is never emitted here —
 * only `Content-Security-Policy-Report-Only`. Violations are reported,
 * never blocked.
 */
export function buildSecurityHeaders(options: {
  isProduction: boolean;
  referrerPolicy?: string;
}): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    {
      key: "Referrer-Policy",
      value: options.referrerPolicy ?? "strict-origin-when-cross-origin",
    },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value:
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    },
    {
      key: "Content-Security-Policy-Report-Only",
      value: buildReportOnlyCsp(),
    },
  ];
  if (options.isProduction) {
    headers.push({ key: "Strict-Transport-Security", value: HSTS_HEADER_VALUE });
  }
  return headers;
}
