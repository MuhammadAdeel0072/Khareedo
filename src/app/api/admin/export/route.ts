// Admin exports — Excel (.xlsx) and PDF downloads (server-generated, admin-only).
// GET /api/admin/export?type=reports|products|orders|customers&format=xlsx|pdf
import { requireAdmin } from "@/lib/auth-guard";
import { jsonError, handleRoute } from "@/lib/api";
import { buildWorkbook } from "@/lib/export/excel";
import { buildPdfReport } from "@/lib/export/pdf";
import {
  getReportsExportData,
  getProductsExportData,
  getOrdersExportData,
  getCustomersExportData,
} from "@/services/export.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function money(n: number): string {
  return `Rs ${Math.max(0, Math.round(n)).toLocaleString("en-PK")}`;
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function binaryResponse(buf: Buffer, mime: string, filename: string): Response {
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") ?? "";
    const format = searchParams.get("format") ?? "";
    if (!["reports", "products", "orders", "customers"].includes(type)) {
      return jsonError("Unknown export type.", 400);
    }
    if (!["xlsx", "pdf"].includes(format)) {
      return jsonError("Unknown export format.", 400);
    }

    const filename = `khareedo-${type}-${fileStamp()}.${format}`;

    if (type === "reports") {
      const { summary, lowStock } = await getReportsExportData();
      const avg =
        summary.totalOrders > 0 ? Math.round(summary.totalRevenue / summary.totalOrders) : 0;

      if (format === "xlsx") {
        const buf = await buildWorkbook([
          {
            name: "Summary",
            title: "Khareedo Report — Summary",
            columns: [{ label: "Metric", width: 28 }, { label: "Value", width: 20 }],
            rows: [
              ["Orders (all time)", summary.totalOrders],
              ["Revenue (last 30 days)", summary.totalRevenue],
              ["Average order value", avg],
              ...summary.byStatus.map((s) => [`Orders — ${s.status}`, s.count] as (string | number)[]),
            ],
          },
          {
            name: "Revenue by Day",
            title: "Daily revenue — last 30 days",
            columns: [{ label: "Date", width: 14 }, { label: "Revenue", width: 18, money: true }],
            rows: summary.revenueByDay.map((r) => [dayLabel(r.date), r.total]),
          },
          {
            name: "Top Products",
            title: "Top 8 products by units sold",
            columns: [
              { label: "#", width: 5 },
              { label: "Product", width: 34 },
              { label: "Units Sold", width: 12 },
              { label: "Revenue", width: 16, money: true },
            ],
            rows: summary.topProducts.map((p, i) => [i + 1, p.name, p.unitsSold, p.revenue]),
          },
          {
            name: "Low Stock",
            title: "Products needing restock (5 or fewer units)",
            columns: [
              { label: "Product", width: 34 },
              { label: "Stock", width: 10 },
              { label: "Price", width: 16, money: true },
            ],
            rows: lowStock.map((p) => [p.name, p.quantity, p.price]),
          },
        ]);
        return binaryResponse(buf, XLSX_MIME, filename);
      }

      const buf = await buildPdfReport(
        { title: "Store Report", subtitle: "Operational insights from real store data" },
        [
          {
            heading: "Summary",
            columns: [{ label: "Metric", weight: 2 }, { label: "Value", align: "right" }],
            rows: [
              ["Orders (all time)", summary.totalOrders.toLocaleString("en-PK")],
              ["Revenue (last 30 days)", money(summary.totalRevenue)],
              ["Average order value", money(avg)],
              ...summary.byStatus.map(
                (s) => [`Orders — ${s.status}`, s.count.toLocaleString("en-PK")] as (string | number)[]
              ),
            ],
          },
          {
            heading: "Top Products",
            note: "By units sold",
            columns: [
              { label: "#", weight: 0.4 },
              { label: "Product", weight: 3 },
              { label: "Units", align: "right", weight: 0.8 },
              { label: "Revenue", align: "right", weight: 1.3 },
            ],
            rows: summary.topProducts.map((p, i) => [i + 1, p.name, p.unitsSold, money(p.revenue)]),
          },
          {
            heading: "Low Stock",
            note: "Products needing restock attention",
            columns: [
              { label: "Product", weight: 3 },
              { label: "Stock", align: "right", weight: 0.8 },
              { label: "Price", align: "right", weight: 1.3 },
            ],
            rows: lowStock.map((p) => [p.name, p.quantity, money(p.price)]),
          },
          {
            heading: "Revenue by Day",
            note: "Last 30 days",
            columns: [
              { label: "Date", weight: 1 },
              { label: "Revenue", align: "right", weight: 1 },
            ],
            rows: summary.revenueByDay.map((r) => [dayLabel(r.date), money(r.total)]),
          },
        ]
      );
      return binaryResponse(buf, "application/pdf", filename);
    }

    if (type === "products") {
      const rows = await getProductsExportData();
      if (format === "xlsx") {
        const buf = await buildWorkbook([
          {
            name: "Products",
            title: `Khareedo catalogue — ${rows.length} products`,
            columns: [
              { label: "Name", width: 30 },
              { label: "SKU", width: 18 },
              { label: "Category", width: 16 },
              { label: "Brand", width: 14 },
              { label: "Price", width: 13, money: true },
              { label: "Compare Price", width: 14, money: true },
              { label: "Stock", width: 8 },
              { label: "Low Stock At", width: 11 },
              { label: "Status", width: 11 },
              { label: "Featured", width: 9 },
              { label: "Rating", width: 8 },
              { label: "Created", width: 12 },
            ],
            rows: rows.map((p) => [
              p.name, p.sku, p.category, p.brand, p.price, p.comparePrice,
              p.stock, p.lowStockThreshold, p.status, p.featured, p.rating, p.createdAt,
            ]),
          },
        ]);
        return binaryResponse(buf, XLSX_MIME, filename);
      }
      const buf = await buildPdfReport(
        { title: "Product Catalogue", subtitle: `${rows.length} products in the store` },
        [
          {
            heading: "Products",
            columns: [
              { label: "Product", weight: 3 },
              { label: "SKU", weight: 1.4 },
              { label: "Category", weight: 1.2 },
              { label: "Price", align: "right", weight: 1 },
              { label: "Stock", align: "right", weight: 0.7 },
              { label: "Status", weight: 1 },
            ],
            rows: rows.map((p) => [p.name, p.sku, p.category, money(p.price), p.stock, p.status]),
          },
        ]
      );
      return binaryResponse(buf, "application/pdf", filename);
    }

    if (type === "orders") {
      const { orders, items } = await getOrdersExportData();
      if (format === "xlsx") {
        const buf = await buildWorkbook([
          {
            name: "Orders",
            title: `Khareedo orders — ${orders.length} most recent`,
            columns: [
              { label: "Reference", width: 17 },
              { label: "Customer", width: 18 },
              { label: "Email", width: 24 },
              { label: "Phone", width: 14 },
              { label: "City", width: 12 },
              { label: "Items", width: 7 },
              { label: "Subtotal", width: 13, money: true },
              { label: "Discount", width: 12, money: true },
              { label: "Delivery", width: 12, money: true },
              { label: "Total", width: 14, money: true },
              { label: "Payment", width: 13 },
              { label: "Pay Status", width: 11 },
              { label: "Status", width: 12 },
              { label: "Date", width: 12 },
            ],
            rows: orders.map((o) => [
              o.reference, o.customer, o.email, o.phone, o.city, o.items,
              o.subtotal, o.discount, o.deliveryFee, o.total,
              o.paymentMethod, o.paymentStatus, o.status, o.date,
            ]),
          },
          {
            name: "Order Items",
            title: "Line items for the exported orders",
            columns: [
              { label: "Reference", width: 17 },
              { label: "Product", width: 30 },
              { label: "SKU", width: 18 },
              { label: "Qty", width: 7 },
              { label: "Unit Price", width: 13, money: true },
              { label: "Line Total", width: 14, money: true },
            ],
            rows: items.map((it) => [
              it.reference, it.product, it.sku, it.quantity, it.unitPrice, it.lineTotal,
            ]),
          },
        ]);
        return binaryResponse(buf, XLSX_MIME, filename);
      }
      const buf = await buildPdfReport(
        { title: "Orders Report", subtitle: `${orders.length} most recent orders` },
        [
          {
            heading: "Orders",
            columns: [
              { label: "Reference", weight: 1.5 },
              { label: "Customer", weight: 2 },
              { label: "City", weight: 1 },
              { label: "Items", align: "right", weight: 0.6 },
              { label: "Total", align: "right", weight: 1.1 },
              { label: "Payment", weight: 1 },
              { label: "Status", weight: 1.1 },
              { label: "Date", weight: 1 },
            ],
            rows: orders.map((o) => [
              o.reference, o.customer, o.city, o.items, money(o.total),
              o.paymentMethod, o.status, o.date,
            ]),
          },
        ]
      );
      return binaryResponse(buf, "application/pdf", filename);
    }

    // customers
    const rows = await getCustomersExportData();
    if (format === "xlsx") {
      const buf = await buildWorkbook([
        {
          name: "Customers",
          title: `Khareedo customers — ${rows.length} registered`,
          columns: [
            { label: "Name", width: 22 },
            { label: "Email", width: 26 },
            { label: "Phone", width: 15 },
            { label: "Orders", width: 9 },
            { label: "Total Spent", width: 15, money: true },
            { label: "Addresses", width: 11 },
            { label: "Joined", width: 12 },
          ],
          rows: rows.map((c) => [c.name, c.email, c.phone, c.orders, c.totalSpent, c.addresses, c.joined]),
        },
      ]);
      return binaryResponse(buf, XLSX_MIME, filename);
    }
    const buf = await buildPdfReport(
      { title: "Customers Report", subtitle: `${rows.length} registered customers` },
      [
        {
          heading: "Customers",
          columns: [
            { label: "Name", weight: 1.6 },
            { label: "Email", weight: 2.2 },
            { label: "Phone", weight: 1.2 },
            { label: "Orders", align: "right", weight: 0.7 },
            { label: "Total Spent", align: "right", weight: 1.2 },
            { label: "Joined", weight: 1 },
          ],
          rows: rows.map((c) => [c.name, c.email, c.phone, c.orders, money(c.totalSpent), c.joined]),
        },
      ]
    );
    return binaryResponse(buf, "application/pdf", filename);
  });
}
