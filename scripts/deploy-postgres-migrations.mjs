import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const databaseUrl = process.env.SUPABASE_POSTGRES_URL;
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const caPath = process.env.SUPABASE_DB_CA_CERT;
if (!databaseUrl || !projectUrl || !caPath) {
  throw new Error("Set SUPABASE_POSTGRES_URL, NEXT_PUBLIC_SUPABASE_URL, and SUPABASE_DB_CA_CERT.");
}

const database = new URL(databaseUrl);
const project = new URL(projectUrl);
const projectRef = project.hostname.split(".")[0];
const targetMatches =
  database.hostname === `db.${projectRef}.supabase.co` ||
  database.username.endsWith(`.${projectRef}`) ||
  database.hostname.startsWith(`${projectRef}.`);
if (!targetMatches) throw new Error("The PostgreSQL URL does not match the configured Supabase project.");

readFileSync(resolve(caPath), "utf8");
database.searchParams.set("sslmode", "verify-full");
database.searchParams.set("sslrootcert", resolve(caPath));
process.env.DATABASE_URL = database.toString();

const result = spawnSync(
  process.execPath,
  [
    "node_modules/prisma/build/index.js",
    "migrate",
    "deploy",
    "--schema",
    "prisma/schema.postgres.prisma",
  ],
  { stdio: "inherit", env: process.env, windowsHide: true }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
