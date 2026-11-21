import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient as PostgresPrismaClient } from "../../generated/postgres-client";
import {
  getPerformanceContext,
  isDebugLoggingEnabled,
} from "@/lib/performance-timing";

type PrismaClient = ReturnType<typeof createPrismaClient>;

const SUPABASE_POOLER_CONNECTION_LIMIT = 3;
// Prisma's default pool_timeout in seconds — set explicitly rather than
// relying on the default, so the wait-for-a-connection behaviour is visible
// and tunable in one place. Kept at the default value: a saturated pool
// fails fast with a clear timeout instead of queueing indefinitely.
const SUPABASE_POOLER_POOL_TIMEOUT_SECONDS = 10;
// Server-side statement timeout in milliseconds (Stage 2 audit). Without
// it, one hung query can hold one of the 3 pool connections indefinitely
// (a pg_sleep-style stall, a pathological plan, a lock wait) while the
// pool_timeout above only bounds WAITING for a connection, never the
// query itself. 30s: the checkout transaction budget is 15s and the pool
// wait is 10s, so any single statement past 30s is pathological, while
// legitimate slow reads (admin exports, dashboard aggregates) keep ample
// headroom. Enforced by the server (error 57014, connection stays
// usable), not by dropping the connection client-side.
const STATEMENT_TIMEOUT_MS = 30_000;
const SLOW_DATABASE_OPERATION_THRESHOLD_MS = 1_000;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export function postgresConnectionUrl(): string {
  const connectionString = process.env.SUPABASE_POSTGRES_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_POSTGRES_URL is required for the application database.");
  }

  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("SUPABASE_POSTGRES_URL must be a PostgreSQL connection URL.");
  }

  // Loopback databases (local dev / preview / CI) have no TLS layer; anything
  // else — including every real Supabase host — keeps strict verify-full TLS.
  const isLoopbackDb = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  url.searchParams.set("sslmode", isLoopbackDb ? "disable" : "verify-full");
  // Pool sizing for Supabase pooler hosts (R3). Supabase runs two pooler
  // modes: session mode on :5432 (the URL .env.example documents — the mode
  // this project uses) and transaction mode on :6543. The old condition
  // only matched port 5432, so a :6543 URL silently got no limit at all and
  // Prisma's default pool (2 x CPUs + 1 connections) applied — the exact
  // thing the limit exists to prevent on a shared PgBouncer. The limit now
  // applies to ANY pooler host regardless of port (an empty port also means
  // 5432, the PostgreSQL default). Direct *.supabase.co hosts are
  // untouched: a direct connection has no PgBouncer in front, so Prisma's
  // default pool is the right size there. An explicit connection_limit /
  // pool_timeout in the URL always wins over these defaults. The limit
  // stays at 3 (conservative — one long-running server process; PgBouncer
  // session mode holds a server connection per client connection, so a
  // small pool avoids exhausting the pooler's per-user budget).
  if (url.hostname.endsWith(".pooler.supabase.com")) {
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set(
        "connection_limit",
        String(SUPABASE_POOLER_CONNECTION_LIMIT)
      );
    }
    if (!url.searchParams.has("pool_timeout")) {
      url.searchParams.set(
        "pool_timeout",
        String(SUPABASE_POOLER_POOL_TIMEOUT_SECONDS)
      );
    }
  }

  // Statement timeout (R4): libpq's `options` startup parameter carries
  // `-c statement_timeout=…` to the server, and Prisma 6's query engine
  // (quaint, tokio-postgres) forwards `options` verbatim — verified
  // against disposable Postgres 16.4: SHOW statement_timeout returns
  // 30s and SELECT pg_sleep(35) is cancelled by the server at ~30s with
  // the connection left usable (see audit-stage2-fixes.md). An explicit
  // `options` in the URL always wins. Applies to the app runtime pool
  // only: `prisma migrate deploy` builds its DATABASE_URL from the raw
  // env value (scripts/deploy-postgres-migrations.mjs), never through
  // this function, so migrations keep no statement timeout. STAGING
  // CHECK (unverifiable from this sandbox): confirm SHOW
  // statement_timeout returns 30s on a Supabase connection — if the
  // Supavisor pooler strips the `options` startup parameter, the
  // fallback is a one-time `ALTER ROLE <app role> SET statement_timeout`
  // in the Supabase SQL editor, not a code change.
  if (!url.searchParams.has("options")) {
    url.searchParams.set(
      "options",
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    );
  }

  // Supabase Postgres (pooler and direct hosts) presents a certificate signed
  // by Supabase's private CA (Supabase Root 2021 CA), which is not in the
  // runtime's trusted roots. Without the downloaded CA certificate, verify-full
  // TLS fails with a cryptic certificate error, so fail fast with an actionable
  // message instead. Loopback databases are unaffected (sslmode=disable).
  const isSupabaseHost =
    url.hostname.endsWith(".pooler.supabase.com") ||
    url.hostname.endsWith(".supabase.co");
  const caCertificate = process.env.SUPABASE_DB_CA_CERT;
  if (isSupabaseHost && !caCertificate) {
    throw new Error(
      "SUPABASE_DB_CA_CERT is required when connecting to a Supabase host. " +
        "Supabase Postgres presents a certificate signed by Supabase's private CA, " +
        "which is not in the runtime's trusted roots, so verify-full TLS fails without it. " +
        "Download the CA certificate from Supabase Dashboard → Database Settings → SSL Configuration " +
        "and set SUPABASE_DB_CA_CERT to its file path."
    );
  }
  if (caCertificate) {
    const caPath = resolve(caCertificate);
    readFileSync(caPath);
    url.searchParams.set("sslrootcert", caPath);
  }

  return url.toString();
}

function createPrismaClient() {
  const client = new PostgresPrismaClient({
    datasources: { db: { url: postgresConnectionUrl() } },
    log: ["error"],
  });

  return client.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (
          operation === "$queryRaw" ||
          operation === "$queryRawUnsafe" ||
          operation === "$executeRaw" ||
          operation === "$executeRawUnsafe"
        ) {
          return query(args);
        }
        const context = getPerformanceContext();
        if (!context && !isDebugLoggingEnabled) return query(args);

        const startedAt = performance.now();
        try {
          return await query(args);
        } finally {
          const durationMs = Math.round(performance.now() - startedAt);
          if (durationMs >= SLOW_DATABASE_OPERATION_THRESHOLD_MS) {
            console.warn(
              `[performance:slow] database=${model ?? "raw"}.${operation} durationMs=${durationMs}`
            );
          }
        }
      },
    },
  });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

// Cache the client on globalThis in EVERY environment: the standalone prod
// server can evaluate this module more than once (per server bundle), and a
// fresh PrismaClient per evaluation would open its own pool — connection
// storms and serialized queries under load. Harmless in dev, protective in prod.
globalForPrisma.prisma = db;
