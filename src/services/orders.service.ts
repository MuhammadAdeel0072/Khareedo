// Orders service — customer history/tracking (FR-25/26) + admin processing (FR-41, BR-11).
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import {
  ORDER_STATUS_TRANSITIONS,
  STOCK_RESTORING_STATUSES,
  type OrderStatus,
} from "@/lib/constants";
import { withPerformanceTiming } from "@/lib/performance-timing";
import { ReservationIntegrityError, updateManagedOrderStatus } from "@/services/safepay-reservations.service";

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
  return withPerformanceTiming("orders.history", async () => {
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      // _count avoids materializing one row per item just to show item counts
      include: { _count: { select: { items: true } } },
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
      itemCount: o._count.items,
      createdAt: o.createdAt,
      customerName: o.customerName,
      isGuest: o.isGuest,
    })) satisfies OrderSummaryRow[],
    total,
    page,
    pages: Math.ceil(total / perPage),
  };
  });
}

/** Fetch a single order for customer-or-guest viewing. */
export async function getOrderByReference(reference: string, userId?: string) {
    return withPerformanceTiming("orders.confirmation", async () => {
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
    });
  }

  export async function getOrderById(id: string) {
    return withPerformanceTiming("orders.details", () =>
      db.order.findUnique({
        where: { id },
        include: {
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
          user: { select: { id: true, email: true, name: true } },
        },
      })
    );
}

// ───────────────────────────── Admin (FR-41, BR-11, BR-14) ─────────────────────────────

export interface AdminOrderFilters {
  status?: string;
  q?: string; // reference or customer name/email/phone
  page?: number;
}

export async function adminGetOrderById(id: string) {
  return db.order.findUnique({
    where: { id },
    select: {
      id: true,
      reference: true,
      status: true,
      paymentMethod: true,
      paymentStatus: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      isGuest: true,
      shipFullName: true,
      shipPhone: true,
      shipLine1: true,
      shipLine2: true,
      shipCity: true,
      shipProvince: true,
      shipPostalCode: true,
      subtotal: true,
      discountTotal: true,
      deliveryFee: true,
      deliveryMethod: true,
      giftWrapCharge: true,
      giftWrapSelected: true,
      giftWrapMessage: true,
      couponCode: true,
      total: true,
      notes: true,
      createdAt: true,
      items: {
        select: {
          id: true,
          productName: true,
          productSlug: true,
          imageUrl: true,
          unitPrice: true,
          quantity: true,
          lineTotal: true,
          giftWrap: true,
        },
      },
      user: { select: { email: true } },
    },
  });
}

/** Shared WHERE builder for admin order listing AND exports (single source of truth). */
export function adminOrderListWhere(filters: AdminOrderFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.q) {
    const q = filters.q.trim();
    if (q) {
      // Case-insensitive text search. PostgreSQL `contains` maps to a
      // case-sensitive LIKE, so an explicit `insensitive` mode is required
      // there; the disposable SQLite test harness runs ASCII case-insensitive
      // LIKE natively (same user-visible behavior) and does not support the
      // mode flag (perf/system-optimization convention).
      const insensitive =
        process.env.KHAREEDO_DISPOSABLE_SQLITE_TEST === "1"
          ? undefined
          : ("insensitive" as const);
      where.OR = [
        { reference: { contains: q, mode: insensitive } },
        { customerName: { contains: q, mode: insensitive } },
        { customerEmail: { contains: q, mode: insensitive } },
        { customerPhone: { contains: q, mode: insensitive } },
      ];
    }
  }
  return where;
}

export async function adminListOrders(filters: AdminOrderFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = 15;
  const where = adminOrderListWhere(filters);
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        reference: true,
        status: true,
        paymentMethod: true,
        paymentStatus: true,
        total: true,
        createdAt: true,
        customerName: true,
        customerEmail: true,
        isGuest: true,
        _count: { select: { items: true } },
      },
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
      itemCount: o._count.items,
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

  // Managed payments must never enter the legacy cancellation/restock/mark-failed branch.
  if (order.paymentFlowVersion !== null) {
    try {
      return await db.$transaction(tx => updateManagedOrderStatus(tx, orderId, next, new Date()),
        { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
    } catch (error) {
      if (error instanceof ReservationIntegrityError)
        return { ok: false, error: "Reservation integrity requires review. No changes were committed." };
      throw error;
    }
  }
  if (order.paymentMethod === "ONLINE" && order.paymentStatus !== "PAID" && next !== "CANCELLED")
    return { ok: false, error: "Unpaid online orders cannot be fulfilled." };

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
      where: { id: orderId, status: current, version: order.version, paymentFlowVersion: null },
      data: { status: next, paymentStatus, version: { increment: 1 } },
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
          data: { quantity: { increment: item.quantity }, version: { increment: 1 } },
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
