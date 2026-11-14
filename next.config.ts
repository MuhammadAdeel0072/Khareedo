import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
