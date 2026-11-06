// Real SQLite regressions: run only through the marked disposable database harness.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

vi.mock("@/lib/db", async () => {
  assertDisposableTestDatabase();
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }),
  };
});

import { db } from "@/lib/db";

assertDisposableTestDatabase();

const createdOrderIds: string[] = [];
type PaymentMethod = "COD" | "BANK_TRANSFER";
type Pointer = "active" | "accepted" | "both";

function orderData(paymentMethod: PaymentMethod = "COD") {
  const key = randomUUID();
  return {
    reference: "REL-" + key,
    idempotencyKey: "relation-test-" + key,
    customerName: "Synthetic relation test",
    customerEmail: "relation-test@example.invalid",
    customerPhone: "03000000000",
    shipFullName: "Synthetic relation test",
    shipPhone: "03000000000",
    shipLine1: "Synthetic address",
    shipCity: "Test city",
    shipProvince: "Test province",
    subtotal: 1250,
    total: 1250,
    paymentMethod,
  };
}

async function nestedOrder(paymentMethod: PaymentMethod = "COD") {
  const order = await db.order.create({
    data: {
      ...orderData(paymentMethod),
      items: {
        create: {
          productName: "Saved synthetic item",
          productSlug: "saved-synthetic-item",
          unitPrice: 1250,
          quantity: 1,
          lineTotal: 1250,
        },
      },
      payments: { create: { provider: paymentMethod, amount: 1250 } },
    },
    include: { items: true, payments: true },
  });
  createdOrderIds.push(order.id);
  return order;
}

function pointers(which: Pointer, paymentId: string) {
  return {
    activePaymentId: which === "accepted" ? null : paymentId,
    acceptedPaymentId: which === "active" ? null : paymentId,
  };
}

afterAll(async () => {
  // Clear only this suite's pointers before its synthetic orders cascade to children.
  await db.order.updateMany({
    where: { id: { in: createdOrderIds } },
    data: { paymentOwnerOrderId: null, activePaymentId: null, acceptedPaymentId: null },
  });
  await db.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await db.$disconnect();
});

describe("automatic order IDs with payment ownership relations", () => {
  it.each(["COD", "BANK_TRANSFER"] as const)("generates a cuid for a plain %s order", async (method) => {
    const data = orderData(method);
    expect(data).not.toHaveProperty("id");
    const order = await db.order.create({ data });
    createdOrderIds.push(order.id);
    expect(order.id).toMatch(/^c[a-z0-9]+$/);
    expect(order).toMatchObject({
      paymentMethod: method,
      total: 1250,
      paymentFlowVersion: null,
      paymentOwnerOrderId: null,
      activePaymentId: null,
      acceptedPaymentId: null,
    });
  });

  it.each(["COD", "BANK_TRANSFER"] as const)("generates linked IDs for nested %s items and payment", async (method) => {
    const order = await nestedOrder(method);
    expect(order.id).toMatch(/^c[a-z0-9]+$/);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ orderId: order.id, unitPrice: 1250, lineTotal: 1250 });
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({
      orderId: order.id,
      provider: method,
      amount: 1250,
      status: "PENDING",
      attemptNumber: null,
    });
  });
});

describe("same-order active and accepted payment ownership", () => {
  it("allows distinct active and accepted payments belonging to the same order", async () => {
    const order = await nestedOrder();
    const second = await db.payment.create({ data: { orderId: order.id, provider: "COD", amount: 1250 } });
    const changed = await db.order.update({
      where: { id: order.id },
      data: {
        paymentOwnerOrderId: order.id,
        activePaymentId: second.id,
        acceptedPaymentId: order.payments[0].id,
      },
    });
    expect(changed.activePaymentId).toBe(second.id);
    expect(changed.acceptedPaymentId).toBe(order.payments[0].id);
  });

  it.each(["active", "accepted"] as const)("rejects a foreign %s payment with the correct row owner", async (which) => {
    const order = await nestedOrder();
    const foreign = await nestedOrder();
    await expect(db.order.update({
      where: { id: order.id },
      data: { paymentOwnerOrderId: order.id, ...pointers(which, foreign.payments[0].id) },
    })).rejects.toMatchObject({ code: "P2003" });
  });

  for (const operation of ["insert", "update"] as const) {
    for (const owner of ["null", "foreign"] as const) {
      it.each(["active", "accepted", "both"] as const)(
        "rejects " + operation + " of %s pointers with a " + owner + " owner",
        async (which) => {
          const order = await nestedOrder();
          const foreign = await nestedOrder();
          const data = {
            paymentOwnerOrderId: owner === "null" ? null : foreign.id,
            ...pointers(which, foreign.payments[0].id),
          };
          // With a null owner, composite FKs alone would skip the reference.
          // With the foreign owner, they would match the foreign payment.
          // Both therefore require the additional row ownership constraint.
          const write = operation === "insert"
            ? db.order.create({ data: { ...orderData(), ...data } })
            : db.order.update({ where: { id: order.id }, data });
          await expect(write).rejects.toThrow();
        }
      );
    }
  }

  it("requires the owner to remain set until both pointers are cleared", async () => {
    const order = await nestedOrder();
    await db.order.update({
      where: { id: order.id },
      data: { paymentOwnerOrderId: order.id, ...pointers("both", order.payments[0].id) },
    });
    await expect(db.order.update({
      where: { id: order.id },
      data: { paymentOwnerOrderId: null, activePaymentId: null },
    })).rejects.toThrow();
    const cleared = await db.order.update({
      where: { id: order.id },
      data: { paymentOwnerOrderId: null, activePaymentId: null, acceptedPaymentId: null },
    });
    expect(cleared.paymentOwnerOrderId).toBeNull();
    expect(cleared.activePaymentId).toBeNull();
    expect(cleared.acceptedPaymentId).toBeNull();
  });
});

