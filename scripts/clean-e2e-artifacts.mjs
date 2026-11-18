/**
 * KHAREEDO — purge E2E artifacts from the demo database.
 * Deletes: orders placed by "E2E Guest Tester" / audit probes, products named
 * "E2E Test Product" / "CONCURRENCY TEST PROD" (with images/inventory/payments).
 * Keeps: the 9 seeded demo orders + gift-wrap demo order.
 *
 * Safety (PR-07): the target must be a local SQLite file (DATABASE_URL must
 * be a `file:` URL, never PostgreSQL, never production), and the script is
 * dry-run by default — it lists what would be deleted and deletes nothing.
 * Pass --apply to delete for real.
 */
import { PrismaClient } from "../generated/sqlite-client/index.js";
import {
  checkLocalSqliteTarget,
  resolveRunMode,
} from "./db-target-guards.mjs";

const target = checkLocalSqliteTarget(process.env);
if (target.status !== "ok") {
  console.error(`clean-e2e-artifacts: refused: ${target.reason}`);
  process.exit(1);
}
const mode = resolveRunMode(process.argv.slice(2));
if (mode.status !== "ok") {
  console.error(`clean-e2e-artifacts: refused: ${mode.reason}`);
  process.exit(1);
}
console.log(`target database: ${target.databasePath} (mode: ${mode.mode})`);

const db = new PrismaClient();
try {
  const JUNK_ORDER_NAMES = ["E2E Guest Tester", "Audit Probe", "Race Customer", "Idem Test"];
  const JUNK_PRODUCT_NAMES = ["E2E Test Product", "CONCURRENCY TEST PROD"];

  const junkOrders = await db.order.findMany({
    where: { customerName: { in: JUNK_ORDER_NAMES } },
    select: { id: true, reference: true },
  });
  const junkProducts = await db.product.findMany({
    where: { name: { in: JUNK_PRODUCT_NAMES } },
    select: { id: true, name: true },
  });

  if (mode.mode === "dry-run") {
    console.log(
      `dry-run: would purge ${junkOrders.length} orders (${junkOrders.map((o) => o.reference).join(", ") || "none"}) and ${junkProducts.length} products (${junkProducts.map((p) => p.name).join(", ") || "none"}). Nothing was deleted. Re-run with --apply to delete.`,
    );
  } else {
    for (const o of junkOrders) {
      await db.payment.deleteMany({ where: { orderId: o.id } });
      await db.orderItem.deleteMany({ where: { orderId: o.id } });
      await db.order.delete({ where: { id: o.id } });
    }
    console.log(`orders purged: ${junkOrders.length}`);

    for (const p of junkProducts) {
      await db.inventory.deleteMany({ where: { productId: p.id } });
      await db.productImage.deleteMany({ where: { productId: p.id } });
      await db.product.delete({ where: { id: p.id } });
    }
    console.log(`products purged: ${junkProducts.length}`);
  }

  const products = await db.product.count();
  const orders = await db.order.count();
  console.log(`remaining: products=${products} orders=${orders}`);

  // stock health: any catalog product at 0?
  const zero = await db.inventory.findMany({ where: { quantity: 0 }, select: { productId: true } });
  console.log(`zero-stock rows: ${zero.length}`);
  if (zero.length) {
    for (const z of zero.slice(0, 10)) {
      const p = await db.product.findUnique({ where: { id: z.productId }, select: { name: true, status: true } });
      console.log(`  zero: ${p?.name} (${p?.status})`);
    }
  }
} finally {
  await db.$disconnect();
}
