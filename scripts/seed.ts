// Khareedo database seed — thin CLI wrapper around src/lib/seed.ts.
// Usage (from the repo root):
//   SEED_ALLOW=1 bun scripts/seed.ts
//   SEED_ALLOW=1 SEED_ADMIN_PASSWORD=<strong> SEED_CUSTOMER_PASSWORD=<strong> bun scripts/seed.ts
//   SEED_ALLOW=1 npx tsx --env-file=.env scripts/seed.ts   (tsx does not auto-load .env)
//
// The seed is opt-in, non-production, and local-SQLite-only: it refuses
// unless SEED_ALLOW=1, NODE_ENV is not production, and DATABASE_URL is a
// local `file:` URL. It never deletes or overwrites existing rows —
// re-running it only fills in missing seed data. Accounts are created only
// when their password is supplied via the environment (see docs/SEEDING.md);
// without a password the account is skipped, and an existing account is
// never touched. Passwords are never printed.
import { PrismaClient } from "../generated/sqlite-client";
import { runSeed } from "../src/lib/seed";

const db = new PrismaClient();

async function main() {
  const summary = await runSeed(db, process.env);
  const lines = [
    "Seed complete (safe, non-destructive — existing rows were left untouched).",
    `  settings: ${summary.settingsPresent} present · categories: ${summary.categoriesPresent} present · products: ${summary.productsPresent} present · coupons: ${summary.couponsPresent} present`,
    `  banners created: ${summary.bannersCreated} · promotions created: ${summary.promotionsCreated} · demo orders created: ${summary.ordersCreated} (${summary.ordersAlreadyPresent} already present)`,
  ];
  if (summary.usersCreated.length > 0) {
    lines.push(`  accounts created: ${summary.usersCreated.join(", ")}`);
  }
  if (summary.usersAlreadyPresent.length > 0) {
    lines.push(`  accounts already present (untouched): ${summary.usersAlreadyPresent.join(", ")}`);
  }
  if (summary.usersSkippedNoPassword.length > 0) {
    lines.push(
      `  accounts skipped (no password supplied): ${summary.usersSkippedNoPassword.join(", ")} — set SEED_ADMIN_PASSWORD / SEED_CUSTOMER_PASSWORD to create them`,
    );
  }
  lines.push(
    "Passwords are never printed. Keep SEED_ADMIN_PASSWORD / SEED_CUSTOMER_PASSWORD in your local environment only.",
  );
  console.log(lines.join("\n"));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
