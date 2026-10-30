// Admin: bulk product import from an Excel (.xlsx) file (FR-39 companion).
// POST /api/admin/import/products  — multipart/form-data, field "file".
import ExcelJS from "exceljs";
import { requireAdmin } from "@/lib/auth-guard";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";
import { parseProductsSheet, IMPORT_MAX_ROWS, type SheetRow } from "@/lib/import/products";
import { adminCreateProduct } from "@/services/products.service";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError("Invalid upload — please choose an Excel (.xlsx) file.", 400);
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError("Please choose an Excel (.xlsx) file to import.", 422);
    }
    if (file.size === 0) {
      return jsonError("The selected file is empty.", 422);
    }
    if (file.size > MAX_FILE_BYTES) {
      return jsonError("File is too large (maximum 2 MB).", 413);
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return jsonError("Only .xlsx files are supported. Use the template as a starting point.", 422);
    }

    let workbook: ExcelJS.Workbook;
    try {
      workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch {
      return jsonError("Could not read the file — is it a valid Excel workbook?", 422);
    }

    const ws = workbook.worksheets[0];
    if (!ws) {
      return jsonError("The file has no sheets. Download the template for the correct layout.", 422);
    }

    // Convert the sheet to dense rows, keeping real Excel row numbers for errors.
    const rows: SheetRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values ?? []) as unknown[]; // index 0 is unused
      const cells: unknown[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(values[c] ?? null);
      rows.push({ rowNumber: row.number, cells });
    });

    const parsed = parseProductsSheet(rows);
    const issues = [...parsed.issues];

    // Reference data — loaded once, matched case-insensitively in JS
    // (Prisma `mode: "insensitive"` is not supported on SQLite).
    const [categories, existingProducts] = await Promise.all([
      db.category.findMany({ select: { id: true, name: true } }),
      db.product.findMany({ where: { deletedAt: null }, select: { name: true } }),
    ]);
    const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
    const existingNames = new Set(existingProducts.map((p) => p.name.toLowerCase()));

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of parsed.rows) {
      if (existingNames.has(row.name.toLowerCase())) {
        skipped++;
        issues.push({ rowNumber: row.rowNumber, message: `"${row.name}" already exists in the store — skipped` });
        continue;
      }
      const categoryId = categoryIdByName.get(row.category.toLowerCase());
      if (!categoryId) {
        failed++;
        issues.push({ rowNumber: row.rowNumber, message: `Category "${row.category}" not found — create it first or fix the spelling` });
        continue;
      }
      try {
        await adminCreateProduct({
          name: row.name,
          description: row.description,
          brand: row.brand,
          categoryId,
          price: row.price,
          comparePrice: row.comparePrice ?? null,
          status: row.status,
          isFeatured: row.featured,
          rating: 0,
          reviewCount: 0,
          tags: row.tags,
          images: row.imageUrl ? [row.imageUrl] : [],
          stock: row.stock,
          lowStockThreshold: row.lowStockThreshold,
        });
        created++;
        existingNames.add(row.name.toLowerCase()); // guard duplicates inside the same file
      } catch (e) {
        failed++;
        issues.push({
          rowNumber: row.rowNumber,
          message: `"${row.name}" could not be saved: ${e instanceof Error ? e.message : "unknown error"}`,
        });
      }
    }

    return jsonOk({
      created,
      skipped,
      failed,
      totalRows: parsed.rows.length,
      maxRows: IMPORT_MAX_ROWS,
      emptyRowsSkipped: parsed.emptyRowsSkipped,
      errors: issues.slice(0, 50),
    });
  });
}
