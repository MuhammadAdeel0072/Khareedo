import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient as PostgresPrismaClient } from "../../generated/postgres-client";
import {
  getPerformanceContext,
  isDebugLoggingEnabled,
} from "@/lib/performance-timing";

type PrismaClient = ReturnType<typeof createPrismaClient>;

const SUPABASE_SESSION_POOL_CONNECTION_LIMIT = 3;
const SLOW_DATABASE_OPERATION_THRESHOLD_MS = 1_000;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function postgresConnectionUrl(): string {
  const connectionString = process.env.SUPABASE_POSTGRES_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_POSTGRES_URL is required for the application database.");
  }

  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("SUPABASE_POSTGRES_URL must be a PostgreSQL connection URL.");
  }

  url.searchParams.set("sslmode", "verify-full");
  if (
    url.hostname.endsWith(".pooler.supabase.com") &&
    Number(url.port || 5432) === 5432 &&
    !url.searchParams.has("connection_limit")
  ) {
    url.searchParams.set(
      "connection_limit",
      String(SUPABASE_SESSION_POOL_CONNECTION_LIMIT)
    );
  }

  const caCertificate = process.env.SUPABASE_DB_CA_CERT;
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

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
