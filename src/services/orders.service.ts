// Orders service — customer history/tracking (FR-25/26) + admin processing (FR-41, BR-11).
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import {
  ORDER_STATUS_TRANSITIONS,
  STOCK_RESTORING_STATUSES,
  type OrderStatus,
} from "@/lib/constants";

export interface OrderSummaryRow {
  id: string;
  reference: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  total: number;
  itemCount: number;
  createdAt: Date;
  customerName: string;
  isGuest: boolean;
}

/** Customer's own orders — scoped by session userId server-side (FR-26, NFR-11). */
export async function getUserOrders(userId: string, page = 1, perPage = 10) {
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: { items: { select: { id: true } } },
    }),
    db.order.count({ where: { userId } }),
  ]);
  return {
    items: rows.map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      total: o.total,
      itemCount: o.items.length,
      createdAt: o.createdAt,
      customerName: o.customerName,
      isGuest: o.isGuest,
    })) satisfies OrderSummaryRow[],
    total,
    page,
    pages: Math.ceil(total / perPage),
  };
}

/** Fetch a single order for customer-or-guest viewing. */
export async function getOrderByReference(reference: string, userId?: string) {
  const order = await db.order.findUnique({
    where: { reference },
    include: {
      items: true,
      payments: { orderBy: { createdAt: "desc" }, take: 1 },
      user: { select: { id: true, email: true } },
    },
  });
  if (!order) return null;
  // Guests may view via reference (know-only link); customers must own the order (NFR-11)
  if (order.userId && order.userId !== userId) return null;
  return order;
}

export async function getOrderById(id: string) {
  return db.order.findUnique({
    where: { id },
    include: {
      items: true,
      payments: { orderBy: { createdAt: "desc" } },
      user: { select: { id: true, email: true, name: true } },
    },
  });
}

// ───────────────────────────── Admin (FR-41, BR-11, BR-14) ─────────────────────────────

export interface AdminOrderFilters {
  status?: string;
  q?: string; // reference or customer name/email/phone
  page?: number;
}

export async function adminListOrders(filters: AdminOrderFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = 15;
  const where: Prisma.OrderWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.q) {
    const q = filters.q.trim();
    where.OR = [
      { reference: { contains: q } },
      { customerName: { contains: q } },
      { customerEmail: { contains: q } },
      { customerPhone: { contains: q } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: { items: { select: { id: true } } },
    }),
    db.order.count({ where }),
  ]);
  return {
    items: rows.map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      total: o.total,
      itemCount: o.items.length,
      createdAt: o.createdAt,
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      isGuest: o.isGuest,
    })),
    total,
    page,
    perPage,
    pages: Math.ceil(total / perPage),
  };
}

export interface StatusUpdateResult {
  ok: boolean;
  error?: string;
}

/**
 * Update order status through the state machine (docs §6).
 * Cancellation from stock-holding statuses restores inventory (BR-11).
 * COD orders delivered → payment PAID (settlement policy).
 */
export async function adminUpdateOrderStatus(
  orderId: string,
  next: OrderStatus
): Promise<StatusUpdateResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) return { ok: false, error: "Order not found." };

  const current = order.status as OrderStatus;
  const allowed = ORDER_STATUS_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    return { ok: false, error: `Cannot move an order from ${current} to ${next}.` };
  }

  const updated = await db.$transaction(async (tx) => {
    const paymentStatus =
      next === "DELIVERED" && order.paymentMethod === "COD"
        ? "PAID"
        : next === "CANCELLED"
          ? order.paymentMethod === "COD"
            ? "PENDING"
            : order.paymentStatus
          : order.paymentStatus;

    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: current },
      data: { status: next, paymentStatus },
    });
    if (claimed.count !== 1) return false;

    // Product deletion sets productId to null; the order snapshot remains, but
    // there is no longer inventory to restore. A linked product must have its
    // inventory row, otherwise throw and roll back the status claim.
    if (next === "CANCELLED" && STOCK_RESTORING_STATUSES.includes(current)) {
      for (const item of order.items) {
        if (!item.productId) continue;
        const restored = await tx.inventory.updateMany({
          where: { productId: item.productId },
          data: { quantity: { increment: item.quantity } },
        });
        if (restored.count !== 1) {
          throw new Error(
            `Unable to restore inventory for product ${item.productId} while cancelling order ${orderId}.`
          );
        }
      }
    }

    if (next === "DELIVERED" && order.paymentMethod === "COD") {
      await tx.payment.updateMany({
        where: { orderId, status: "PENDING" },
        data: { status: "PAID" },
      });
    }
    if (next === "CANCELLED") {
      await tx.payment.updateMany({
        where: { orderId, status: "PENDING" },
        data: { status: order.paymentMethod === "COD" ? "PENDING" : "FAILED" },
      });
    }
    return true;
  });

  return updated
    ? { ok: true }
    : { ok: false, error: "The order status changed before this update could be applied." };
}
