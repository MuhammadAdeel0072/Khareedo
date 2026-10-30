import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
      "./tool-results/**",
    ],
  },
  reactStrictMode: false,
};

export default nextConfig;
