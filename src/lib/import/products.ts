// Product import (Excel) — pure parsing/validation logic, unit-testable.
// The route supplies rows from the uploaded workbook; this module maps headers,
// coerces values and validates each row without touching the database.
import { z } from "zod";

export interface SheetRow {
  /** Real Excel row number (header row = 1) for accurate error messages. */
  rowNumber: number;
  cells: unknown[];
}

export interface ParsedProductRow {
  rowNumber: number;
  name: string;
  category: string;
  brand?: string;
  price: number;
  comparePrice?: number | null;
  stock: number;
  lowStockThreshold?: number;
  description?: string;
  tags?: string;
  imageUrl?: string;
  status: "PUBLISHED" | "DRAFT";
  featured: boolean;
}

export interface ImportIssue {
  rowNumber: number | null;
  message: string;
}

export const IMPORT_MAX_ROWS = 200;

/** Column aliases → canonical field (header cells are normalized: lowercase, alphanumeric only). */
const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  productname: "name",
  category: "category",
  categoryname: "category",
  brand: "brand",
  price: "price",
  sellingprice: "price",
  compareprice: "comparePrice",
  wasprice: "comparePrice",
  originalprice: "comparePrice",
  oldprice: "comparePrice",
  stock: "stock",
  quantity: "stock",
  qty: "stock",
  lowstockthreshold: "lowStockThreshold",
  threshold: "lowStockThreshold",
  lowstock: "lowStockThreshold",
  lowstockat: "lowStockThreshold",
  description: "description",
  desc: "description",
  details: "description",
  tags: "tags",
  keywords: "tags",
  imageurl: "imageUrl",
  image: "imageUrl",
  imageurls: "imageUrl",
  picture: "imageUrl",
  status: "status",
  featured: "featured",
  isfeatured: "featured",
};

const REQUIRED_HEADERS = ["name", "category", "price", "stock"] as const;

function normalizeHeader(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text.trim(); // rich text
    if (typeof obj.result === "string") return obj.result.trim(); // formula
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((rt) => String((rt as { text?: string }).text ?? "")).join("").trim();
    }
    if (typeof obj.hyperlink === "string") return obj.hyperlink.trim();
    return "";
  }
  return String(v).trim();
}

function coerceInt(v: unknown, field: string, rowNumber: number, issues: ImportIssue[]): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) {
    issues.push({ rowNumber, message: `${field} must be a number (got "${String(v).trim().slice(0, 30)}")` });
    return undefined;
  }
  return Math.round(n);
}

const rowSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(120, "Name must be 120 characters or fewer"),
  category: z.string().min(1, "Category is required").max(80),
  brand: z.string().max(80).optional(),
  price: z.number().int("Price must be a whole number (Rs)").positive("Price must be greater than 0").max(10_000_000),
  comparePrice: z.number().int().positive().max(10_000_000).nullable().optional(),
  stock: z.number().int("Stock must be a whole number").min(0, "Stock cannot be negative").max(100_000),
  lowStockThreshold: z.number().int().min(1).max(999).optional(),
  description: z.string().max(5000).optional(),
  tags: z.string().max(300).optional(),
  imageUrl: z.string().max(600).optional(),
  status: z.enum(["PUBLISHED", "DRAFT"]),
  featured: z.boolean(),
});

export interface ParseResult {
  rows: ParsedProductRow[];
  issues: ImportIssue[];
  emptyRowsSkipped: number;
}

export function parseProductsSheet(rows: SheetRow[]): ParseResult {
  const issues: ImportIssue[] = [];
  const out: ParsedProductRow[] = [];
  let emptyRowsSkipped = 0;

  if (rows.length === 0) {
    issues.push({ rowNumber: null, message: "The uploaded sheet is empty." });
    return { rows: out, issues, emptyRowsSkipped };
  }

  // ── Header mapping ───────────────────────────────────────────────────────
  const headerRow = rows[0];
  const map = new Map<string, number>();
  headerRow.cells.forEach((cell, idx) => {
    const field = HEADER_ALIASES[normalizeHeader(cell)];
    if (field && !map.has(field)) map.set(field, idx);
  });
  const missing = REQUIRED_HEADERS.filter((h) => !map.has(h));
  if (missing.length > 0) {
    issues.push({
      rowNumber: headerRow.rowNumber,
      message: `Missing required column(s): ${missing.join(", ")}. Download the template for the exact layout.`,
    });
    return { rows: out, issues, emptyRowsSkipped };
  }

  // ── Data rows ────────────────────────────────────────────────────────────
  const dataRows = rows.slice(1, 1 + IMPORT_MAX_ROWS);
  if (rows.length - 1 > IMPORT_MAX_ROWS) {
    issues.push({
      rowNumber: null,
      message: `More than ${IMPORT_MAX_ROWS} data rows — only the first ${IMPORT_MAX_ROWS} will be imported.`,
    });
  }

  const seenNames = new Set<string>();
  const dupInFile: string[] = [];

  for (const { rowNumber, cells } of dataRows) {
    const get = (field: string): unknown => {
      const idx = map.get(field);
      return idx === undefined ? undefined : cells[idx];
    };

    const name = cellText(get("name"));
    const category = cellText(get("category"));
    const brand = cellText(get("brand")) || undefined;
    const description = cellText(get("description")) || undefined;
    const tags = cellText(get("tags")) || undefined;
    const imageUrl = cellText(get("imageUrl")) || undefined;

    const priceRaw = coerceInt(get("price"), "Price", rowNumber, issues);
    const stockRaw = coerceInt(get("stock"), "Stock", rowNumber, issues);
    const compareRaw = coerceInt(get("comparePrice"), "Compare Price", rowNumber, issues);
    const thresholdRaw = coerceInt(get("lowStockThreshold"), "Low Stock At", rowNumber, issues);

    const isBlank = !name && !category && (priceRaw === undefined || Number.isNaN(priceRaw));
    if (isBlank) {
      emptyRowsSkipped++;
      continue;
    }

    const statusText = cellText(get("status")).toUpperCase();
    const status: "PUBLISHED" | "DRAFT" = statusText === "DRAFT" ? "DRAFT" : "PUBLISHED";
    const featuredText = cellText(get("featured")).toLowerCase();
    const featured = ["yes", "y", "true", "1"].includes(featuredText);

    const candidate = {
      name,
      category,
      brand,
      price: priceRaw,
      comparePrice: compareRaw ?? null,
      stock: stockRaw,
      lowStockThreshold: thresholdRaw ?? undefined,
      description,
      tags,
      imageUrl,
      status,
      featured,
    };

    const parsed = rowSchema.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const field = first.path.join(".") || "Row";
      issues.push({ rowNumber, message: `${field}: ${first.message}` });
      continue;
    }

    if (parsed.data.comparePrice !== null && parsed.data.comparePrice !== undefined && parsed.data.comparePrice <= parsed.data.price) {
      issues.push({ rowNumber, message: `Compare Price (${parsed.data.comparePrice}) must be higher than Price (${parsed.data.price})` });
      continue;
    }

    const key = parsed.data.name.toLowerCase();
    if (seenNames.has(key)) {
      dupInFile.push(parsed.data.name);
      issues.push({ rowNumber, message: `"${parsed.data.name}" appears more than once in this file — only the first will be imported` });
      continue;
    }
    seenNames.add(key);

    out.push({ ...parsed.data, rowNumber });
  }

  return { rows: out, issues, emptyRowsSkipped };
}
