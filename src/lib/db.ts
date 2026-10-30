import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient as PostgresPrismaClient } from "../../generated/postgres-client";

type PrismaClient = InstanceType<typeof PostgresPrismaClient>;

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
  const caCertificate = process.env.SUPABASE_DB_CA_CERT;
  if (caCertificate) {
    const caPath = resolve(caCertificate);
    readFileSync(caPath);
    url.searchParams.set("sslrootcert", caPath);
  }

  return url.toString();
}

function createPrismaClient(): PrismaClient {
  return new PostgresPrismaClient({
    datasources: { db: { url: postgresConnectionUrl() } },
    log: ["error"],
  });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;