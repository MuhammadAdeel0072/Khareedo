// Verifies imported smoke-test products landed with correct auto-slug/SKU/stock,
// then removes them (dev DB cleanup) so the catalogue returns to 51 products.
import { PrismaClient } from "../generated/sqlite-client/index.js";

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
  for (const r of rows) {
    await db.inventory.deleteMany({ where: { productId: r.id } });
    await db.productImage.deleteMany({ where: { productId: r.id } });
    await db.product.delete({ where: { id: r.id } });
  }
  console.log(`cleaned=${rows.length}`);
} finally {
  await db.$disconnect();
}
