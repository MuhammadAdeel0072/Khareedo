// Guard wrapper for destructive Prisma commands (PR-07, O-03).
//
// Usage:
//   node scripts/guard-destructive-db.mjs <push|reset|migrate> [--dry-run]
//
// Replaces the bare `prisma db push --accept-data-loss`, `prisma migrate
// reset` and `prisma migrate dev` npm scripts, which ran against whatever
// DATABASE_URL happened to be set — one typo away from production.
//
// Fail-closed, in order:
//   1. The target must be a local SQLite file (DATABASE_URL must be a
//      `file:` URL). Any PostgreSQL URL refuses — the production Supabase
//      database is never a valid target for these commands. A missing
//      DATABASE_URL refuses instead of falling back to any default.
//   2. NODE_ENV=production always refuses.
//   3. The operator must opt in with DB_DESTRUCTIVE_ALLOW=1 exactly.
//   4. --dry-run prints the exact Prisma command and the resolved target
//      path and exits 0 without spawning Prisma.
//
// The legitimate Postgres deploy path is unchanged: `npm run
// db:postgres:deploy` (prisma migrate deploy, non-destructive, with its own
// project-target check) is the only way schema changes reach Supabase.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  checkDestructiveOptIn,
  checkLocalSqliteTarget,
} from "./db-target-guards.mjs";

const COMMANDS = {
  push: ["db", "push", "--accept-data-loss"],
  reset: ["migrate", "reset"],
  migrate: ["migrate", "dev"],
};

function fail(message) {
  console.error(`guard-destructive-db: refused: ${message}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
if (!command || !Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
  fail(
    `unknown command "${command ?? ""}". Usage: node scripts/guard-destructive-db.mjs <push|reset|migrate> [--dry-run]`,
  );
}

const target = checkLocalSqliteTarget(process.env);
if (target.status !== "ok") fail(target.reason);
const optIn = checkDestructiveOptIn(process.env);
if (optIn.status !== "ok") fail(optIn.reason);

const prismaArgs = COMMANDS[command];
const displayTarget = resolve(target.databasePath);
console.log(
  `guard-destructive-db: ${command} -> prisma ${prismaArgs.join(" ")} (target: ${displayTarget})`,
);

if (rest.includes("--dry-run")) {
  console.log("dry-run: Prisma was not executed.");
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", ...prismaArgs],
  { stdio: "inherit", env: process.env, windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
