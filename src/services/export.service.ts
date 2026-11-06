// Admin export data assembly — real DB rows only, no fabricated metrics.
import { db } from "@/lib/db";
import { getReportSummary } from "@/services/reports.service";
import { getLowStockProducts } from "@/services/inventory.service";
import { adminListCustomerSummaries } from "@/services/users.service";

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export async function getReportsExportData() {
  const [summary, lowStock] = await Promise.all([
    getReportSummary(),
    getLowStockProducts(20),
  ]);
  return { summary, lowStock };
}

export interface ProductsExportRow {
  name: string;
  sku: string;
  category: string;
  brand: string;
  price: number;
  comparePrice: number | null;
  stock: number;
  lowStockThreshold: number;
  status: string;
  featured: string;
  rating: number;
  createdAt: string;
}

export async function getProductsExportData(limit = 500): Promise<ProductsExportRow[]> {
  const rows = await db.product.findMany({
    where: { deletedAt: null },
    select: {
      name: true,
      sku: true,
      brand: true,
      price: true,
      comparePrice: true,
      status: true,
      isFeatured: true,
      rating: true,
      createdAt: true,
      category: { select: { name: true } },
      inventory: { select: { quantity: true, lowStockThreshold: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((p) => ({
    name: p.name,
    sku: p.sku ?? "—",
    category: p.category.name,
    brand: p.brand ?? "—",
    price: p.price,
    comparePrice: p.comparePrice,
    stock: p.inventory?.quantity ?? 0,
    lowStockThreshold: p.inventory?.lowStockThreshold ?? 5,
    status: p.status,
    featured: p.isFeatured ? "Yes" : "No",
    rating: p.rating,
    createdAt: fmtDate(p.createdAt),
  }));
}

export interface OrdersExportRow {
  reference: string;
  customer: string;
  email: string;
  phone: string;
  city: string;
  items: number;
  subtotal: number;
  discount: number;
  deliveryFee: number;
  total: number;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  date: string;
}

export interface OrderItemExportRow {
  reference: string;
  product: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export async function getOrdersExportData(
  limit = 1000
): Promise<{ orders: OrdersExportRow[]; items: OrderItemExportRow[] }> {
  const rows = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      reference: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      shipCity: true,
      subtotal: true,
      discountTotal: true,
      deliveryFee: true,
      total: true,
      paymentMethod: true,
      paymentStatus: true,
      status: true,
      createdAt: true,
      items: {
        select: {
          productName: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
          product: { select: { sku: true } },
        },
      },
    },
  });
  const orders: OrdersExportRow[] = [];
  const items: OrderItemExportRow[] = [];
  for (const o of rows) {
    orders.push({
      reference: o.reference,
      customer: o.customerName,
      email: o.customerEmail,
      phone: o.customerPhone,
      city: o.shipCity,
      items: o.items.reduce((s, it) => s + it.quantity, 0),
      subtotal: o.subtotal,
      discount: o.discountTotal,
      deliveryFee: o.deliveryFee,
      total: o.total,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      status: o.status,
      date: fmtDate(o.createdAt),
    });
    for (const it of o.items) {
      items.push({
        reference: o.reference,
        product: it.productName,
        sku: it.product?.sku ?? "—",
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal: it.lineTotal,
      });
    }
  }
  return { orders, items };
}

export interface CustomersExportRow {
  name: string;
  email: string;
  phone: string;
  orders: number;
  totalSpent: number;
  addresses: number;
  joined: string;
}

export async function getCustomersExportData(limit = 1000): Promise<CustomersExportRow[]> {
  const customers = await adminListCustomerSummaries(limit);
  return customers.map((customer) => ({
    name: customer.name ?? "—",
    email: customer.email,
    phone: customer.phone ?? "—",
    orders: customer.orderCount,
    totalSpent: customer.totalSpent,
    addresses: customer.addressCount,
    joined: fmtDate(customer.createdAt),
  }));
}
