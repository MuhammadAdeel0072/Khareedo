// Vitest config for Postgres-only verification (Stream D).
// NOT part of the default runners: `npm test` / `npm run test:db` never pick
// this up (base config includes only tests/unit/**). Run explicitly with:
//   PG_VERIFY_URL='postgresql://pgverify:pgverify-disposable-only@localhost:5432/khareedo_pg_concurrency' \
//     npx vitest run --config tests/postgres/vitest.pg.config.ts
// Requires a disposable local PostgreSQL (never production Supabase).
import { defineConfig } from "vitest/config";
import path from "path";

const pgUrl =
  process.env.PG_VERIFY_URL ??
  "postgresql://pgverify:pgverify-disposable-only@localhost:5432/khareedo_pg_concurrency";
// src/lib/db.ts (used by every service under test) reads SUPABASE_POSTGRES_URL
// at import time; loopback URLs get sslmode=disable there.
process.env.SUPABASE_POSTGRES_URL = pgUrl;
process.env.DATABASE_URL = pgUrl;

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/postgres/**/*.test.{ts,tsx}"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "server-only": path.resolve(__dirname, "../helpers/server-only.ts"),
      "@": path.resolve(__dirname, "../../src"),
    },
  },
});
