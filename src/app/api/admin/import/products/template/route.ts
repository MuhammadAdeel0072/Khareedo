// Admin: downloadable Excel template for bulk product import.
// GET /api/admin/import/products/template
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { handleRoute } from "@/lib/api";
import { buildWorkbook } from "@/lib/export/excel";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(async () => {
    await requireAdminMfaVerified();

    // Example rows use real category names so the first import can succeed as-is.
    const categories = await db.category.findMany({
      orderBy: { sortOrder: "asc" },
      take: 3,
      select: { name: true },
    });
    const cat = (i: number) => categories[i]?.name ?? "Watches";

    const example = (name: string, category: string, price: number, compare: number | null, stock: number) => [
      name, category, "Example Brand", price, compare, stock, 5,
      "Short marketing description of the product.", "example, tag", "", "PUBLISHED", "No",
      "", "", "", "",
    ];

    const exampleVariant = (name: string, category: string, price: number, stock: number, label: string, sku: string, variantPrice: number | null, variantStock: number) => [
      name, category, "Example Brand", price, null, stock, 5,
      "Short marketing description of the product.", "example, tag", "", "PUBLISHED", "No",
      label, sku, variantPrice, variantStock,
    ];

    const buf = await buildWorkbook([
      {
        name: "Products",
        title: "Khareedo — Product Import Template",
        columns: [
          { label: "Name", width: 30 },
          { label: "Category", width: 18 },
          { label: "Brand", width: 15 },
          { label: "Price", width: 12, money: true },
          { label: "Compare Price", width: 14, money: true },
          { label: "Stock", width: 8 },
          { label: "Low Stock At", width: 12 },
          { label: "Description", width: 38 },
          { label: "Tags", width: 18 },
          { label: "Image URL", width: 24 },
          { label: "Status", width: 12 },
          { label: "Featured", width: 10 },
          { label: "Variant Label", width: 20 },
          { label: "Variant SKU", width: 18 },
          { label: "Variant Price", width: 13, money: true },
          { label: "Variant Stock", width: 12 },
        ],
        rows: [
          example(`Sample product A (${cat(0)})`, cat(0), 2499, 2999, 20),
          example(`Sample product B (${cat(1)})`, cat(1), 999, null, 50),
          // Variant example: the same product name on two rows — one row
          // per variant. The first variant row creates the product (with
          // no product-level stock); the second attaches to it.
          exampleVariant(`Sample product C (${cat(2)})`, cat(2), 1499, 0, "Size: S", "SAMPLE-C-S", null, 12),
          exampleVariant(`Sample product C (${cat(2)})`, cat(2), 1499, 0, "Size: M", "SAMPLE-C-M", 1699, 8),
        ],
      },
      {
        name: "Guide",
        title: "How to fill this template",
        columns: [{ label: "Field", width: 18 }, { label: "Rule", width: 90 }],
        rows: [
          ["Name", "Required. Must be unique — products with an existing name are skipped."],
          ["Category", "Required. Must match an existing category name exactly."],
          ["Brand", "Optional."],
          ["Price", "Required. Whole rupees, greater than 0."],
          ["Compare Price", "Optional. Must be higher than Price, otherwise the row fails."],
          ["Stock", "Required. 0 or more."],
          ["Low Stock At", "Optional. Defaults to 5."],
          ["Description", "Optional. Max 5000 characters."],
          ["Tags", "Optional. Comma-separated keywords."],
          ["Image URL", "Optional. One image URL; leave empty to add images later."],
          ["Status", "PUBLISHED (default) or DRAFT."],
          ["Featured", "Yes or No (default No)."],
          ["Variant Label", "Optional. e.g. \"Size: M / Colour: Red\". A row with a Variant Label + SKU is a variant of the named product — use the same product name on one row per variant."],
          ["Variant SKU", "Required on a variant row. Must be unique across all products and variants."],
          ["Variant Price", "Optional. The variant's own price in whole rupees (absolute, not a delta); empty means it uses the product Price."],
          ["Variant Stock", "Optional. The variant's stock. When empty, the Stock column is used as the variant's stock."],
          ["—", "Keep the header row unchanged. Maximum 200 rows per file. Do not rename sheets."],
        ],
      },
    ]);

    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="khareedo-products-import-template.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  });
}
