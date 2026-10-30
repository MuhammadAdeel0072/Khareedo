// Builds a test .xlsx for the admin import endpoint using REAL category names
// from the database: 2 valid rows, 1 duplicate-of-existing row, 1 bad category.
import ExcelJS from "exceljs";
import { PrismaClient } from "../generated/sqlite-client/index.js";

const db = new PrismaClient();
try {
  const cats = await db.category.findMany({
    orderBy: { sortOrder: "asc" },
    take: 2,
    select: { name: true },
  });
  const existing = await db.product.findFirst({
    where: { deletedAt: null },
    select: { name: true },
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow(["Name", "Category", "Brand", "Price", "Compare Price", "Stock", "Low Stock At", "Description", "Tags", "Image URL", "Status", "Featured"]);
  ws.addRow(["Import Smoke Product A", cats[0]?.name ?? "Watches", "SmokeBrand", 1499, null, 25, 5, "Smoke test row A", "smoke", "", "PUBLISHED", "No"]);
  ws.addRow(["Import Smoke Product B", cats[1]?.name ?? "Bags", "", "2,990", 3499, "30", "", "", "", "", "draft", "YES"]);
  ws.addRow([existing?.name ?? "Definitely Missing Product", cats[0]?.name ?? "Watches", "", 500, null, 3]); // → skipped (already exists)
  ws.addRow(["Bad Category Row", "NoSuchCategoryXYZ", "", 500, null, 3]); // → failed (unknown category)

  await wb.xlsx.writeFile("/home/z/my-project/scripts/tmp-import.xlsx");
  console.log(JSON.stringify({ ok: true, cats: cats.map((c) => c.name), dupOf: existing?.name }));
} finally {
  await db.$disconnect();
}
