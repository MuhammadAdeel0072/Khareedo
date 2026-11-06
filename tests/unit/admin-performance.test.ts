import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  userFindMany: vi.fn(),
  orderGroupBy: vi.fn(),
  orderFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $executeRaw: database.executeRaw,
    $queryRaw: database.queryRaw,
    user: { findMany: database.userFindMany },
    order: {
      groupBy: database.orderGroupBy,
      findMany: database.orderFindMany,
    },
  },
}));

import {
  getDashboardStats,
  getRecentOrders,
  getRevenueByDay,
} from "@/services/reports.service";
import { saveSettings } from "@/services/settings.service";
import { adminListCustomerSummaries } from "@/services/users.service";

describe("admin performance queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads dashboard statistics with one query and preserves numeric values", async () => {
    database.queryRaw.mockResolvedValue([{
      totalOrders: 12,
      totalCustomers: 8,
      totalProducts: 20,
      totalRevenue: 120000,
      lowStockCount: 2,
      revenueThisMonth: 45000,
      ordersThisMonth: 5,
      ordersLastMonth: 4,
    }]);

    await expect(getDashboardStats()).resolves.toEqual({
      totalOrders: 12,
      totalCustomers: 8,
      totalProducts: 20,
      totalRevenue: 120000,
      lowStockCount: 2,
      revenueThisMonth: 45000,
      ordersThisMonth: 5,
      ordersLastMonth: 4,
    });
    expect(database.queryRaw).toHaveBeenCalledTimes(1);
    const [queryParts, ...values] = database.queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const queryText = Array.from(queryParts).join("");
    expect(queryText).toContain('"status" <> \'CANCELLED\'');
    expect(queryText).not.toContain('"status" = \'PENDING\'');
    expect(values.filter((value) => value instanceof Date)).toHaveLength(4);
  });

  it("aggregates chart revenue per day in SQL instead of transferring each order", async () => {
    const now = new Date();
    now.setDate(now.getDate() - 30);
    now.setHours(0, 0, 0, 0);
    now.setDate(now.getDate() + 10);
    const date = now.toISOString().slice(0, 10);
    database.queryRaw.mockResolvedValue([{ date, total: 4_200 }]);

    const rows = await getRevenueByDay();

    expect(rows).toHaveLength(30);
    expect(rows.find((row) => row.date === date)?.total).toBe(4_200);
    const [queryParts, ...values] = database.queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const queryText = Array.from(queryParts).join("");
    expect(queryText).toContain('SUM("total")');
    expect(queryText).toContain('GROUP BY SUBSTR(CAST("createdAt" AS TEXT), 1, 10)');
    expect(queryText).toContain('"status" <> \'CANCELLED\'');
    expect(values).toHaveLength(1);
    expect(database.orderFindMany).not.toHaveBeenCalled();
  });

  it("uses a relation count for recent order item totals", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    database.orderFindMany.mockResolvedValue([{
      id: "order-1",
      reference: "KH-1",
      customerName: "Customer",
      total: 100,
      status: "PENDING",
      createdAt,
      _count: { items: 2 },
    }]);

    await expect(getRecentOrders(1)).resolves.toEqual([{
      id: "order-1",
      reference: "KH-1",
      customerName: "Customer",
      itemCount: 2,
      total: 100,
      status: "PENDING",
      createdAt,
    }]);
    expect(database.orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ _count: { select: { items: true } } }) })
    );
  });

  it("aggregates customer order totals without loading order histories", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    database.userFindMany.mockResolvedValue([{
      id: "customer-1",
      name: "Customer",
      email: "customer@example.com",
      phone: null,
      createdAt,
      _count: { addresses: 2 },
    }]);
    database.orderGroupBy.mockResolvedValue([{
      userId: "customer-1",
      _count: { _all: 2 },
      _sum: { total: 650 },
    }]);

    await expect(adminListCustomerSummaries()).resolves.toEqual([{
      id: "customer-1",
      name: "Customer",
      email: "customer@example.com",
      phone: null,
      createdAt,
      orderCount: 2,
      totalSpent: 650,
      addressCount: 2,
    }]);
    expect(database.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ orders: expect.anything() }) })
    );
    expect(database.orderGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["userId"],
        where: {
          userId: { in: ["customer-1"] },
          status: { not: "CANCELLED" },
        },
        _count: { _all: true },
        _sum: { total: true },
      })
    );
  });

  it("saves all provided settings in one parameterized upsert", async () => {
    await saveSettings({
      store_name: "Shop's Name",
      cod_enabled: false,
      delivery_fee_standard: 225,
    });

    expect(database.executeRaw).toHaveBeenCalledTimes(1);
    const statement = database.executeRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(statement.sql).toContain('INSERT INTO "StoreSetting"');
    expect(statement.sql).toContain('ON CONFLICT ("key") DO UPDATE');
    expect(statement.sql).not.toContain("Shop's Name");
    expect(statement.values).toEqual(expect.arrayContaining([
      "store_name", "Shop's Name", "cod_enabled", "false",
      "delivery_fee_standard", "225",
    ]));
  });

  it("does not issue a database query for an empty settings update", async () => {
    await saveSettings({});
    expect(database.executeRaw).not.toHaveBeenCalled();
  });
});
