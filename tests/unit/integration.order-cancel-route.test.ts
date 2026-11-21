// Route tests — customer order cancellation endpoint (Phase 3, chunk 2-final
// — H-11/D1). The service invariants live in integration.orders.test.ts;
// this file pins the HTTP mapping: 401 unauthenticated, 404 non-owner,
// 409 wrong status, 422 bad reason, 200 + idempotent double-cancel.
// Run with: npm run test:db
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const sessionUser = vi.hoisted(() => ({ id: "" }));

// The route's handleRoute maps AuthError via instanceof — vitest gives
// @/lib/api the same mocked AuthError class, so the check still works.
// The error classes live inside the factory because vi.mock is hoisted
// above the module body (a top-level class would be uninitialized).
vi.mock("@/lib/auth-guard", () => {
  class TestAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  class TestMfaError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 403) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    AuthError: TestAuthError,
    MfaRequiredError: TestMfaError,
    getSessionUser: async () => (sessionUser.id ? { id: sessionUser.id } : null),
    requireUser: async () => {
      if (!sessionUser.id) throw new TestAuthError("Please sign in to continue", 401);
      return { id: sessionUser.id };
    },
  };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

import { db } from "@/lib/db";
import { POST as cancelOrder } from "@/app/api/account/orders/[id]/cancel/route";

assertDisposableTestDatabase();

const created = { users: [] as string[], orders: [] as string[] };

async function seedUser() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
  created.users.push(user.id);
  return user;
}

async function seedOrder(userId: string, status = "CONFIRMED") {
  const suffix = randomUUID();
  const order = await db.order.create({
    data: {
      reference: `KHC-${suffix.slice(0, 8)}`,
      idempotencyKey: `cancel-route-${suffix}`,
      userId,
      isGuest: false,
      customerName: "Route Buyer",
      customerEmail: "route@buyer.pk",
      customerPhone: "03001234567",
      shipFullName: "Route Buyer",
      shipPhone: "03001234567",
      shipLine1: "Test Street 1",
      shipCity: "Lahore",
      shipProvince: "Punjab",
      status,
      paymentMethod: "COD",
      paymentStatus: "PENDING",
      subtotal: 1000,
      total: 1000,
    },
  });
  created.orders.push(order.id);
  return order;
}

function cancelRequest(orderId: string, body: unknown = {}) {
  return new Request(`http://localhost/api/account/orders/${orderId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionUser.id = "";
});

afterAll(async () => {
  // Chunk 7-final: the cancel route enqueues a cancellation email. Remove
  // this file's rows so later suites' small outbox sweeps are not starved
  // by leftovers.
  await db.emailOutbox.deleteMany({ where: { email: "route@buyer.pk" } });
  await db.order.deleteMany({ where: { id: { in: created.orders } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

describe("POST /api/account/orders/[id]/cancel", () => {
  it("returns 401 when unauthenticated", async () => {
    const user = await seedUser();
    const order = await seedOrder(user.id);
    const res = await cancelOrder(cancelRequest(order.id), { params: Promise.resolve({ id: order.id }) });
    expect(res.status).toBe(401);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CONFIRMED");
  });

  it("returns 404 for a non-owner and changes nothing", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const order = await seedOrder(owner.id);
    sessionUser.id = stranger.id;
    const res = await cancelOrder(cancelRequest(order.id), { params: Promise.resolve({ id: order.id }) });
    expect(res.status).toBe(404);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CONFIRMED");
  });

  it("cancels the owner's order, stores the reason, and is idempotent", async () => {
    const user = await seedUser();
    const order = await seedOrder(user.id);
    sessionUser.id = user.id;

    const res = await cancelOrder(cancelRequest(order.id, { reason: "Ordered by mistake" }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, alreadyCancelled: false });
    expect(body.order).toMatchObject({ status: "CANCELLED", paymentStatus: "CANCELLED" });
    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.cancelReason).toBe("Ordered by mistake");
    expect(fresh.cancelledBy).toBe(`customer:${user.id}`);

    const again = await cancelOrder(cancelRequest(order.id), { params: Promise.resolve({ id: order.id }) });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, alreadyCancelled: true });
  });

  it("returns 409 for a shipped order and 422 for a non-string reason", async () => {
    const user = await seedUser();
    const shipped = await seedOrder(user.id, "SHIPPED");
    sessionUser.id = user.id;
    const res = await cancelOrder(cancelRequest(shipped.id), { params: Promise.resolve({ id: shipped.id }) });
    expect(res.status).toBe(409);

    const order = await seedOrder(user.id);
    const bad = await cancelOrder(cancelRequest(order.id, { reason: 42 }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(bad.status).toBe(422);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CONFIRMED");
  });
});
