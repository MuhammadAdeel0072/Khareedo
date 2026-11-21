// Integration test — dated order status history + carrier/tracking
// (Phase 3, Chunk 6 — M-6/D4, M-5/D3). Run with: npm run test:db
//
// Covers, against the real Prisma layer on a disposable SQLite database:
// - placeOrder writes the initial CONFIRMED history entry in the same
//   transaction as the order (COD orders are CONFIRMED on placement, D3);
// - adminUpdateOrderStatus writes one dated entry per transition, stores
//   carrier/tracking on the SHIPPED transition, and the entries are readable
//   through getOrderById (customer view) in chronological order;
// - customerCancelOrder writes the CANCELLED entry with the customer actor
//   and the cancel reason as its note;
// - an order with no transitions yet has an empty history.
//
// All assertions are scoped to this file's own orders, so the shared
// disposable database is safe here.
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
import { placeOrder } from "@/services/checkout.service";
import type { PlaceOrderInput } from "@/lib/validation";
import {
  adminUpdateOrderStatus,
  customerCancelOrder,
  getOrderById,
} from "@/services/orders.service";
import { getOrderStatusHistory } from "@/services/order-status-history.service";

assertDisposableTestDatabase();

const orderIds: string[] = [];
const userIds: string[] = [];

async function seedDirectOrder(status = "PENDING", userId?: string) {
  const ref = `KH-HIST-${randomUUID().slice(0, 8).toUpperCase()}`;
  const order = await db.order.create({
    data: {
      reference: ref,
      userId: userId ?? null,
      customerName: "History Test",
      customerEmail: "history@example.com",
      customerPhone: "03001234567",
      status,
      paymentMethod: "COD",
      paymentStatus: "PENDING",
      isGuest: false,
      idempotencyKey: `idem-${ref}`,
      subtotal: 1000,
      deliveryFee: 0,
      total: 1000,
      shipFullName: "History Test",
      shipPhone: "03001234567",
      shipLine1: "1 Test Street",
      shipCity: "Lahore",
      shipProvince: "Punjab",
    },
  });
  orderIds.push(order.id);
  return order;
}

async function seedCustomer() {
  const user = await db.user.create({
    data: { email: `history-${randomUUID()}@example.com`, role: "CUSTOMER", emailVerified: new Date() },
  });
  userIds.push(user.id);
  return user;
}

beforeEach(async () => {
  for (const id of orderIds.splice(0)) {
    await db.orderStatusHistory.deleteMany({ where: { orderId: id } });
    await db.order.delete({ where: { id } }).catch(() => {});
  }
  for (const id of userIds.splice(0)) {
    await db.user.delete({ where: { id } }).catch(() => {});
  }
});

afterAll(async () => {
  // Chunk 7-final: order placement/status changes now enqueue customer
  // emails in the outbox. Remove this file's rows so later suites' small
  // outbox sweeps are not starved by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: "history@example.com" } });
  for (const id of orderIds.splice(0)) {
    await db.orderStatusHistory.deleteMany({ where: { orderId: id } });
    await db.order.delete({ where: { id } }).catch(() => {});
  }
  for (const id of userIds.splice(0)) {
    await db.user.delete({ where: { id } }).catch(() => {});
  }
});

describe("M-6 status history", () => {
  it("placeOrder writes the initial CONFIRMED entry for a COD order", async () => {
    const user = await seedCustomer();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const category = await db.category.create({
      data: { name: `HistCat-${suffix}`, slug: `histcat-${suffix}`, isActive: true },
    });
    const product = await db.product.create({
      data: {
        name: "History Test Watch",
        slug: `hist-watch-${suffix}`,
        categoryId: category.id,
        status: "PUBLISHED",
        price: 1000,
      },
    });
    await db.inventory.create({ data: { productId: product.id, quantity: 10 } });
    const cart = await db.cart.create({
      data: {
        userId: user.id,
        items: { create: { productId: product.id, quantity: 1, giftWrap: false } },
      },
    });
    const input: PlaceOrderInput = {
      idempotencyKey: `hist-place-${randomUUID()}`,
      customer: { name: "History Test", email: "history@example.com", phone: "03001234567" },
      address: {
        fullName: "History Test",
        phone: "03001234567",
        line1: "1 Test Street",
        line2: "",
        city: "Lahore",
        province: "Punjab",
        postalCode: "",
      },
      deliveryMethod: "STANDARD",
      paymentMethod: "COD",
    };
    const result = await placeOrder(input, user.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    orderIds.push(result.orderId);
    await db.cart.delete({ where: { id: cart.id } }).catch(() => {});
    const history = await getOrderStatusHistory(result.orderId);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("CONFIRMED");
    expect(history[0].actor).toBe(`customer:${user.id}`);
    expect(history[0].note).toBe("Order placed");
  });

  it("admin transitions write dated entries and store carrier/tracking on SHIPPED", async () => {
    const order = await seedDirectOrder("PENDING");
    expect(await adminUpdateOrderStatus(order.id, "CONFIRMED")).toEqual({ ok: true });
    expect(await adminUpdateOrderStatus(order.id, "PROCESSING")).toEqual({ ok: true });
    const shipped = await adminUpdateOrderStatus(order.id, "SHIPPED", undefined, {
      carrier: "TCS",
      trackingNumber: "TRK123",
    });
    expect(shipped).toEqual({ ok: true });
    expect(await adminUpdateOrderStatus(order.id, "DELIVERED")).toEqual({ ok: true });

    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.carrier).toBe("TCS");
    expect(fresh.trackingNumber).toBe("TRK123");
    expect(fresh.paymentStatus).toBe("PAID"); // COD delivery settles payment

    const history = await getOrderStatusHistory(order.id);
    expect(history.map((h) => h.status)).toEqual(["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"]);
    // Dated and chronological.
    for (const h of history) expect(h.createdAt).toBeInstanceOf(Date);
    const times = history.map((h) => h.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // The customer view (getOrderById) carries the same timeline.
    const user = await seedCustomer();
    await db.order.update({ where: { id: order.id }, data: { userId: user.id } });
    const viewed = await getOrderById(order.id, user.id);
    expect(viewed?.statusHistory.map((h) => h.status)).toEqual([
      "CONFIRMED",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
    ]);
    expect(viewed?.carrier).toBe("TCS");
    expect(viewed?.trackingNumber).toBe("TRK123");
  });

  it("customer cancel writes the CANCELLED entry with actor and reason", async () => {
    const user = await seedCustomer();
    const order = await seedDirectOrder("CONFIRMED", user.id);
    const result = await customerCancelOrder(order.id, user.id, "Changed my mind");
    expect(result.ok).toBe(true);
    const history = await getOrderStatusHistory(order.id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("CANCELLED");
    expect(history[0].actor).toBe(`customer:${user.id}`);
    expect(history[0].note).toBe("Changed my mind");
  });

  it("admin cancel writes the CANCELLED entry", async () => {
    const order = await seedDirectOrder("CONFIRMED");
    const result = await adminUpdateOrderStatus(order.id, "CANCELLED", undefined, {
      cancelReason: "Duplicate order",
    });
    expect(result).toEqual({ ok: true });
    const history = await getOrderStatusHistory(order.id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("CANCELLED");
    expect(history[0].actor).toBe("system");
    expect(history[0].note).toBe("Duplicate order");
  });

  it("an order with no transitions yet has an empty history", async () => {
    const order = await seedDirectOrder("PENDING");
    expect(await getOrderStatusHistory(order.id)).toEqual([]);
  });
});
