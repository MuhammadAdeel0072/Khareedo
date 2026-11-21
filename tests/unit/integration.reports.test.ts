// Integration test — reports revenue is paid-only (Phase 3, Chunk 6 —
// M-33/D18). Run with: npm run test:db
//
// Covers, against the real Prisma layer on a disposable SQLite database:
// - only paymentStatus PAID (and not cancelled) counts as revenue, in the
//   dashboard totals, the this-month figures, the per-day chart and the
//   reports summary;
// - pending (unpaid) amounts are exposed separately and never inside the
//   paid total;
// - cancelled, refunded and failed orders are excluded from both figures.
//
// This file asserts on absolute aggregates, so it runs against its own
// genuinely isolated disposable database (see ISOLATED_TEST_FILES in
// scripts/run-isolated-sqlite-tests.mjs) — it must never depend on another
// suite's rows.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    }),
  };
});
import { db } from "@/lib/db";
import {
  getDashboardStats,
  getPendingRevenue,
  getReportSummary,
  getRevenueByDay,
} from "@/services/reports.service";

assertDisposableTestDatabase();

async function seedOrder(total: number, status: string, paymentStatus: string, createdAt: Date) {
  const ref = `KH-REP-${randomUUID().slice(0, 8).toUpperCase()}`;
  return db.order.create({
    data: {
      reference: ref,
      customerName: "Reports Test",
      customerEmail: "reports@example.com",
      customerPhone: "03001234567",
      status,
      paymentMethod: "COD",
      paymentStatus,
      isGuest: false,
      idempotencyKey: `idem-${ref}`,
      subtotal: total,
      deliveryFee: 0,
      total,
      shipFullName: "Reports Test",
      shipPhone: "03001234567",
      shipLine1: "1 Test Street",
      shipCity: "Lahore",
      shipProvince: "Punjab",
      createdAt,
    },
  });
}

beforeAll(async () => {
  const now = new Date();
  const old = new Date(now);
  old.setDate(old.getDate() - 40); // always last month or earlier, outside the 30-day window
  // Paid, this month — revenue.
  await seedOrder(1000, "CONFIRMED", "PAID", now);
  await seedOrder(500, "DELIVERED", "PAID", now);
  // Unpaid, this month — pending, never revenue.
  await seedOrder(700, "CONFIRMED", "PENDING", now);
  // Cancelled paid order — the payment stays PAID until refunded, but the
  // sale is cancelled: excluded from revenue.
  await seedOrder(900, "CANCELLED", "PAID", now);
  // Refunded and failed — excluded from both figures.
  await seedOrder(400, "DELIVERED", "REFUNDED", now);
  await seedOrder(300, "CONFIRMED", "FAILED", now);
  // Cancelled unpaid — excluded from pending.
  await seedOrder(200, "CANCELLED", "PENDING", now);
  // Paid, 40 days ago — inside the all-time revenue total, outside this
  // month and outside the 30-day windows.
  await seedOrder(600, "CONFIRMED", "PAID", old);
});

afterAll(async () => {
  await db.order.deleteMany({ where: { customerEmail: "reports@example.com" } });
});

describe("M-33 revenue is paid-only (D18)", () => {
  it("counts only paid, non-cancelled orders as revenue", async () => {
    const stats = await getDashboardStats();
    expect(stats.totalRevenue).toBe(2100); // 1000 + 500 + 600
    expect(stats.revenueThisMonth).toBe(1500); // 1000 + 500
    expect(stats.pendingRevenue).toBe(700);
    expect(stats.pendingRevenueThisMonth).toBe(700);
  });

  it("charts only paid revenue per day", async () => {
    const byDay = await getRevenueByDay(30);
    expect(byDay.reduce((s, r) => s + r.total, 0)).toBe(1500);
    expect(await getPendingRevenue(30)).toBe(700);
  });

  it("separates paid and pending in the reports summary", async () => {
    const summary = await getReportSummary();
    expect(summary.totalRevenue).toBe(1500); // 30-day paid only
    expect(summary.pendingRevenue).toBe(700);
    expect(summary.paidOrders).toBe(2);
    expect(summary.totalOrders).toBe(8);
  });
});
