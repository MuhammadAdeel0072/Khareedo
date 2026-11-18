// Verifies imported smoke-test products landed with correct auto-slug/SKU/stock,
// then removes them (dev DB cleanup) so the catalogue returns to 51 products.
//
// Safety (PR-07): the target must be a local SQLite file (DATABASE_URL must
// be a `file:` URL, never PostgreSQL, never production), and the script is
// dry-run by default — it lists the smoke products and deletes nothing.
// Pass --apply to delete for real.
import { PrismaClient } from "../generated/sqlite-client/index.js";
import {
  checkLocalSqliteTarget,
  resolveRunMode,
} from "./db-target-guards.mjs";

const target = checkLocalSqliteTarget(process.env);
if (target.status !== "ok") {
  console.error(`cleanup-import-test: refused: ${target.reason}`);
  process.exit(1);
}
const mode = resolveRunMode(process.argv.slice(2));
if (mode.status !== "ok") {
  console.error(`cleanup-import-test: refused: ${mode.reason}`);
  process.exit(1);
}
console.log(`target database: ${target.databasePath} (mode: ${mode.mode})`);

const db = new PrismaClient();
try {
  const rows = await db.product.findMany({
    where: { name: { startsWith: "Import Smoke" } },
    include: { inventory: true, images: true },
  });
  console.log(JSON.stringify(rows.map((r) => ({
    name: r.name,
    slug: r.slug,
    sku: r.sku,
    price: r.price,
    stock: r.inventory?.quantity ?? null,
    status: r.status,
    images: r.images.length,
  }))));
  if (mode.mode === "dry-run") {
    console.log(
      `dry-run: would clean ${rows.length} smoke products. Nothing was deleted. Re-run with --apply to delete.`,
    );
  } else {
    for (const r of rows) {
      await db.inventory.deleteMany({ where: { productId: r.id } });
      await db.productImage.deleteMany({ where: { productId: r.id } });
      await db.product.delete({ where: { id: r.id } });
    }
    console.log(`cleaned=${rows.length}`);
  }
} finally {
  await db.$disconnect();
}
