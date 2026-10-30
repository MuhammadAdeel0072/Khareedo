// Product import parser — header mapping, coercion, validation rules.
import { describe, expect, it } from "vitest";
import { parseProductsSheet, type SheetRow } from "@/lib/import/products";

function sheet(...rows: unknown[][]): SheetRow[] {
  return rows.map((cells, i) => ({ rowNumber: i + 1, cells }));
}

const HEADER = ["Name", "Category", "Brand", "Price", "Compare Price", "Stock", "Low Stock At", "Description", "Tags", "Image URL", "Status", "Featured"];

describe("parseProductsSheet", () => {
  it("parses valid rows with defaults", () => {
    const { rows, issues } = parseProductsSheet(
      sheet(HEADER, ["Wall Clock Classic", "Watches", "Casio", "2499", "2999", "12", "4", "Nice clock", "clock, wall", "", "", "Yes"])
    );
    expect(issues).toHaveLength(0);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.name).toBe("Wall Clock Classic");
    expect(r.category).toBe("Watches");
    expect(r.price).toBe(2499);
    expect(r.comparePrice).toBe(2999);
    expect(r.stock).toBe(12);
    expect(r.lowStockThreshold).toBe(4);
    expect(r.status).toBe("PUBLISHED"); // default
    expect(r.featured).toBe(true);
    expect(r.rowNumber).toBe(2); // real Excel row number
  });

  it("maps aliased headers (Product Name / Selling Price / Qty)", () => {
    const { rows, issues } = parseProductsSheet(
      sheet(["Product Name", "Category", "Selling Price", "Qty"], ["Leather Bag", "Bags", 3500, 7])
    );
    expect(issues).toHaveLength(0);
    expect(rows[0].price).toBe(3500);
    expect(rows[0].stock).toBe(7);
    expect(rows[0].featured).toBe(false);
  });

  it("reports missing required headers", () => {
    const { rows, issues } = parseProductsSheet(sheet(["Name", "Price"], ["X", 10]));
    expect(rows).toHaveLength(0);
    expect(issues.some((i) => i.message.includes("Missing required column"))).toBe(true);
  });

  it("rejects comparePrice lower than or equal to price", () => {
    const { rows, issues } = parseProductsSheet(
      sheet(HEADER, ["Cheap Deal", "Watches", "", "1000", "900", "5"])
    );
    expect(rows).toHaveLength(0);
    expect(issues[0].message).toContain("must be higher than Price");
  });

  it("deduplicates names within the file, keeping the first", () => {
    const { rows, issues } = parseProductsSheet(
      sheet(HEADER, ["Duplicate Dan", "Watches", "", "100", null, "1"], ["duplicate dan", "Bags", "", "200", null, "2"])
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(100);
    expect(issues.some((i) => i.message.includes("more than once"))).toBe(true);
  });

  it("skips fully empty rows and coerces numeric strings", () => {
    const { rows, emptyRowsSkipped, issues } = parseProductsSheet(
      sheet(HEADER, ["Real Product", "Bags", "", "1,250", null, " 8 "], [null, null, null, null, null, null])
    );
    expect(issues.filter((i) => i.rowNumber === 3)).toHaveLength(0);
    expect(emptyRowsSkipped).toBe(1);
    expect(rows[0].price).toBe(1250);
    expect(rows[0].stock).toBe(8);
  });

  it("validates ranges (negative stock, non-positive price)", () => {
    const { rows, issues } = parseProductsSheet(
      sheet(HEADER, ["Bad Stock", "Bags", "", "500", null, "-3"], ["Bad Price", "Bags", "", "0", null, "5"])
    );
    expect(rows).toHaveLength(0);
    expect(issues.some((i) => i.message.includes("Stock cannot be negative"))).toBe(true);
    expect(issues.some((i) => i.message.includes("greater than 0"))).toBe(true);
  });
});
