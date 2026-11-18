import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Security response headers + report-only CSP (src/lib/security-headers.ts).
  // Applied to every response Next.js serves (pages, API routes, static
  // assets). HSTS is included only for production builds (NODE_ENV ===
  // "production" at build time); browsers ignore it over plain HTTP.
  // No enforcing Content-Security-Policy header is ever emitted — see
  // docs/SECURITY-HEADERS.md.
  //
  // Verified live: next.config.ts headers override a route handler's own
  // header of the same name. The Safepay routes deliberately pin
  // `Referrer-Policy: no-referrer` on their own responses, so the more
  // specific rules below re-pin it — otherwise the global
  // strict-origin-when-cross-origin would silently weaken them. (Any
  // future route that returns HostedCheckoutRedirect.response() must be
  // added to this pinned list for the same reason.) Later matching rules
  // win for the same header name.
  async headers() {
    const isProduction = process.env.NODE_ENV === "production";
    const base = buildSecurityHeaders({ isProduction });
    const safepay = buildSecurityHeaders({
      isProduction,
      referrerPolicy: "no-referrer",
    });
    return [
      { source: "/:path*", headers: base },
      { source: "/api/checkout/safepay/:path*", headers: safepay },
      { source: "/api/webhooks/safepay", headers: safepay },
    ];
  },
  // Optional storage proxy (sandbox/CI previews only): when LOCAL_STORAGE_PROXY_URL
  // is set, storage requests are transparently proxied to a local storage service,
  // so the browser can load preview uploads same-origin. Unset in production —
  // the real Supabase Storage host is used directly.
  async rewrites() {
    const storageProxy = process.env.LOCAL_STORAGE_PROXY_URL;
    if (!storageProxy) return [];
    return [{ source: "/storage/:path*", destination: `${storageProxy}/storage/:path*` }];
  },
  images: {
  remotePatterns: [
    {
      protocol: "https",
      hostname: "evsxjmtireufyymgsehx.supabase.co",
      pathname: "/storage/v1/object/public/product-images/**",
    },
    {
      protocol: "https",
      hostname: "i5.walmartimages.com",
      pathname: "/seo/**",
    },
  ],
},
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": ["./generated/postgres-client/**/*"],
  },
  outputFileTracingExcludes: {
    "/*": [
      "./.env",
      "./backups/**",
      "./db/**",
      "./docs/**",
      "./generated/sqlite-client/**",
      "./scripts/**",
      "./tests/**",
     "./tool-results/**/*",
    ],
  },
  reactStrictMode: false,
};

export default nextConfig;
