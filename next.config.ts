import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
