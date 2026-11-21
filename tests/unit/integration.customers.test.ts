// Integration test — admin customers list pagination + drill-down
// (Phase 3, Chunk 10). Run with: npm run test:db
//
// Covers, against the real Prisma layer on a disposable SQLite database:
// - adminListCustomerSummaries paginates (page/perPage/total/pages) instead
//   of silently capping at 100 rows, and pages are disjoint;
// - adminGetCustomerById returns the profile, saved addresses and recent
//   orders with the same totals as the list, and null for unknown ids or
//   non-customer users.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  adminGetCustomerById,
  adminListCustomerSummaries,
} from "@/services/users.service";

assertDisposableTestDatabase();

const userIds: string[] = [];

async function seedCustomer(name: string) {
  const user = await db.user.create({
    data: {
      email: `cust-${randomUUID()}@example.com`,
      name,
      role: "CUSTOMER",
      emailVerified: new Date(),
    },
  });
  userIds.push(user.id);
  return user;
}

async function seedOrder(userId: string, total: number, status = "CONFIRMED") {
  const ref = `KH-CUST-${randomUUID().slice(0, 8).toUpperCase()}`;
  return db.order.create({
    data: {
      reference: ref,
      userId,
      customerName: "Customer",
      customerEmail: "customer@example.com",
      customerPhone: "03001234567",
      status,
      paymentMethod: "COD",
      paymentStatus: "PENDING",
      isGuest: false,
      idempotencyKey: `idem-${ref}`,
      subtotal: total,
      deliveryFee: 0,
      total,
      shipFullName: "Customer",
      shipPhone: "03001234567",
      shipLine1: "1 Test Street",
      shipCity: "Lahore",
      shipProvince: "Punjab",
    },
  });
}

beforeEach(async () => {
  for (const id of userIds.splice(0)) {
    await db.order.deleteMany({ where: { userId: id } });
    await db.address.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } }).catch(() => {});
  }
});

afterAll(async () => {
  for (const id of userIds.splice(0)) {
    await db.order.deleteMany({ where: { userId: id } });
    await db.address.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } }).catch(() => {});
  }
  await db.$disconnect();
});

describe("adminListCustomerSummaries pagination", () => {
  it("paginates with disjoint pages and a true total", async () => {
    const a = await seedCustomer("Page One");
    const b = await seedCustomer("Page Two");
    const c = await seedCustomer("Page Three");
    const first = await adminListCustomerSummaries({ page: 1, perPage: 2 });
    expect(first.total).toBeGreaterThanOrEqual(3);
    expect(first.page).toBe(1);
    expect(first.perPage).toBe(2);
    expect(first.pages).toBe(Math.ceil(first.total / 2));
    expect(first.items).toHaveLength(2);
    const second = await adminListCustomerSummaries({ page: 2, perPage: 2 });
    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true);
    const all = await adminListCustomerSummaries({ page: 1, perPage: 100 });
    expect(all.items.some((i) => i.id === a.id)).toBe(true);
    expect(all.items.some((i) => i.id === b.id)).toBe(true);
    expect(all.items.some((i) => i.id === c.id)).toBe(true);
  });

  it("clamps invalid pages to page 1", async () => {
    await seedCustomer("Clamp Test");
    const result = await adminListCustomerSummaries({ page: -3, perPage: 2 });
    expect(result.page).toBe(1);
  });
});

describe("adminGetCustomerById drill-down", () => {
  it("returns profile, addresses, orders and totals", async () => {
    const user = await seedCustomer("Detail Customer");
    await db.address.create({
      data: {
        userId: user.id,
        label: "Home",
        fullName: "Detail Customer",
        phone: "03001234567",
        line1: "1 Test Street",
        city: "Lahore",
        province: "Punjab",
        isDefault: true,
      },
    });
    const order = await seedOrder(user.id, 2500);
    await seedOrder(user.id, 500, "CANCELLED");

    const detail = await adminGetCustomerById(user.id);
    expect(detail).not.toBeNull();
    expect(detail!.email).toBe(user.email);
    expect(detail!.addresses).toHaveLength(1);
    expect(detail!.addresses[0].isDefault).toBe(true);
    // Cancelled orders count in the order list but not in the spent total.
    expect(detail!.orders.some((o) => o.id === order.id)).toBe(true);
    expect(detail!.orderCount).toBe(1);
    expect(detail!.totalSpent).toBe(2500);
  });

  it("returns null for unknown ids and non-customer users", async () => {
    expect(await adminGetCustomerById(randomUUID())).toBeNull();
    const admin = await db.user.create({
      data: { email: `admin-${randomUUID()}@example.com`, name: "Admin", role: "ADMIN" },
    });
    try {
      expect(await adminGetCustomerById(admin.id)).toBeNull();
    } finally {
      await db.user.delete({ where: { id: admin.id } });
    }
  });
});
