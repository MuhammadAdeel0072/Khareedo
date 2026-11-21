// Orders service — customer history/tracking (FR-25/26) + admin processing (FR-41, BR-11).
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import {
  ORDER_STATUS_TRANSITIONS,
  PAYMENT_STATUSES,
  STOCK_RESTORING_STATUSES,
  type OrderStatus,
} from "@/lib/constants";
import { withPerformanceTiming } from "@/lib/performance-timing";
import { ReservationIntegrityError, cancelPaidManagedOrder, updateManagedOrderStatus } from "@/services/safepay-reservations.service";
import { recordOrderStatusHistory } from "@/services/order-status-history.service";
import {
  enqueueOrderCancelledEmail,
  enqueueOrderStatusEmail,
} from "@/services/order-notification.service";
import {
  ADMIN_AUDIT_ACTIONS,
  recordAdminAudit,
  type AdminAuditContext,
} from "@/services/admin-audit.service";

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
  // Negative / NaN pages must not reach Prisma: a negative skip throws and
  // the order-history page 500s (?page=-5). Clamp like the other list
  // services (listProducts, adminListOrders, listAdminAuditLogs).
  const safePage = Math.max(1, Math.floor(page) || 1);
  return withPerformanceTiming("orders.history", async () => {
  const [rows, total] = await Promise.all([
    db.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (safePage - 1) * perPage,
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
    page: safePage,
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
      // Order tracking requires authentication (PR-04, D-01): only the signed-in
      // customer who placed the order may view it by reference. A know-only
      // reference grants no access — legacy guest orders (userId null) are not
      // viewable this way at all; they remain visible to admins only.
      if (!userId) return null;
      if (order.userId !== userId) return null;
      return order;
    });
  }

  /**
   * Fetch a single order for the signed-in customer who placed it (M-4).
   * Ownership is enforced here, at the service layer, so no caller can read
   * another customer's order by id: the query itself is scoped to the
   * requesting user and returns null for anyone else (no existence leak).
   * Legacy guest orders (userId null) never match a signed-in user.
   */
  export async function getOrderById(id: string, userId: string) {
    if (!userId) return null;
    return withPerformanceTiming("orders.details", () =>
      db.order.findFirst({
        where: { id, userId },
        include: {
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
          // Dated status timeline (M-6), oldest first.
          statusHistory: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          user: { select: { id: true, email: true, name: true } },
        },
      })
    );
}

export type CancelActor = { kind: "ADMIN" | "CUSTOMER"; id: string };

/** "admin:<id>" | "customer:<id>" — the Order.cancelledBy value. */
function cancelledByLabel(actor: CancelActor): string {
  return `${actor.kind.toLowerCase()}:${actor.id}`;
}

export interface CancelOrderResult {
  ok: boolean;
  error?: string;
  code?: "NOT_FOUND" | "INVALID_STATUS" | "ERROR";
  alreadyCancelled?: boolean;
  order?: { id: string; reference: string; status: string; paymentStatus: string };
}

/** Statuses a customer may cancel from (D1): mirrors the admin state machine
 * for the pre-fulfilment statuses. SHIPPED/DELIVERED can never be cancelled
 * by anyone through this path. */
export const CUSTOMER_CANCELLABLE_STATUSES: OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING"];

type LegacyCancellableOrder = {
  id: string;
  couponCode: string | null;
  items: Array<{ productId: string | null; variantId: string | null; quantity: number }>;
};

/**
 * Shared legacy cancellation core (Phase 3, Chunk 2-final — D1/D2). Runs
 * inside the caller's transaction AFTER the caller claimed the order row
 * (status + version), so a second cancel can never re-enter it.
 * Restores stock for stock-holding statuses, releases the coupon use with
 * the same compare-and-set discipline as the admin path (H-10), and marks
 * the order's unpaid payment rows CANCELLED — a cancelled unpaid order's
 * payment is CANCELLED, never PENDING (M-7). The caller owns the order-row
 * update itself (status, paymentStatus, cancelledAt/By/Reason).
 */
async function cancelLegacyOrderInTransaction(
  // The transaction client type, not Prisma.TransactionClient: the app adds
  // query timing through $extends, and the extended client is not
  // structurally assignable to the plain TransactionClient (same workaround
  // as updateManagedOrderStatus in safepay-reservations.service.ts).
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  order: LegacyCancellableOrder,
  current: OrderStatus
): Promise<{ couponRestored: boolean }> {
  // Product deletion sets productId to null; the order snapshot remains, but
  // there is no longer inventory to restore. A linked product must have its
  // inventory row, otherwise throw and roll back the status claim. A variant
  // line restores the VARIANT's row (Chunk 8 — D12), a no-variant line the
  // product-level row — `variantId: null` in an updateMany where means IS NULL.
  if (STOCK_RESTORING_STATUSES.includes(current)) {
    for (const item of order.items) {
      if (!item.productId) continue;
      const restored = await tx.inventory.updateMany({
        where: { productId: item.productId, variantId: item.variantId ?? null },
        data: { quantity: { increment: item.quantity }, version: { increment: 1 } },
      });
      if (restored.count !== 1) {
        throw new Error(
          `Unable to restore inventory for product ${item.productId} while cancelling order ${order.id}.`
        );
      }
    }
  }

  // H-10: a cancelled legacy order must not permanently burn its coupon.
  // Checkout reserved the use by incrementing usedCount (reserveCoupon, no
  // CouponReservation row exists for legacy orders), so cancel restores it
  // with the same compare-and-set discipline: decrement only when the count
  // is at least 1. If the coupon row is gone (deleted after the order was
  // placed) there is nothing to restore and the cancellation still completes.
  let couponRestored = false;
  if (order.couponCode) {
    const restored = await tx.coupon.updateMany({
      where: { code: order.couponCode, usedCount: { gte: 1 } },
      data: { usedCount: { decrement: 1 }, version: { increment: 1 } },
    });
    couponRestored = restored.count === 1;
  }

  // Unpaid payment rows on a cancelled order are CANCELLED (M-7/D2) — a
  // cancelled order must never keep showing a PENDING payment.
  await tx.payment.updateMany({
    where: { orderId: order.id, status: "PENDING" },
    data: { status: "CANCELLED" },
  });

  return { couponRestored };
}

/**
 * Customer cancellation (H-11, D1/D2). The customer path reuses the admin
 * cancel core — same transactional restock + coupon release, same CAS claim
 * — it never duplicates that logic. Ownership is enforced by the scoped
 * read (non-owner → NOT_FOUND, no existence leak, same as M-4). The audit
 * log is admin-only (recordAdminAudit takes an admin context), so the
 * cancellation record for a customer cancel is the order's own
 * cancelledAt/cancelledBy/cancelReason columns, not an audit row.
 * Double-cancel is idempotent: a second cancel returns the already-cancelled
 * order, not an error.
 */
export async function customerCancelOrder(
  orderId: string,
  userId: string,
  reason?: string | null
): Promise<CancelOrderResult> {
  const cleanReason =
    typeof reason === "string" ? reason.trim().slice(0, 500) || null : null;
  const order = await db.order.findFirst({
    where: { id: orderId, userId },
    include: { items: true },
  });
  if (!order) return { ok: false, error: "Order not found.", code: "NOT_FOUND" };
  if (order.status === "CANCELLED") {
    return {
      ok: true,
      alreadyCancelled: true,
      order: { id: order.id, reference: order.reference, status: order.status, paymentStatus: order.paymentStatus },
    };
  }
  if (!CUSTOMER_CANCELLABLE_STATUSES.includes(order.status as OrderStatus)) {
    return {
      ok: false,
      error: `An order in ${order.status} status cannot be cancelled.`,
      code: "INVALID_STATUS",
    };
  }

  const now = new Date();
  const cancel = { by: cancelledByLabel({ kind: "CUSTOMER", id: userId }), reason: cleanReason };

  // Managed (Safepay) orders go through the reservation state machine.
  if (order.paymentFlowVersion !== null) {
    try {
      const result = await db.$transaction(
        async (tx) => updateManagedOrderStatus(tx, orderId, "CANCELLED", now, cancel),
        { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 }
      );
      if (result.ok) {
        // Order cancellation email (Chunk 7-final — D14): the cancel just
        // happened in this call, after the transaction committed. The
        // already-cancelled returns below do NOT notify — the email went
        // out with the original cancel.
        await enqueueOrderCancelledEmail({ orderId });
        const fresh = await db.order.findUniqueOrThrow({ where: { id: orderId } });
        return {
          ok: true,
          order: { id: fresh.id, reference: fresh.reference, status: fresh.status, paymentStatus: fresh.paymentStatus },
        };
      }
      // Lost a race with a concurrent cancel (admin or customer): an order
      // that is CANCELLED now is an idempotent success, not an error.
      const fresh = await db.order.findUnique({ where: { id: orderId } });
      if (fresh?.status === "CANCELLED") {
        return {
          ok: true,
          alreadyCancelled: true,
          order: { id: fresh.id, reference: fresh.reference, status: fresh.status, paymentStatus: fresh.paymentStatus },
        };
      }
      return { ok: false, error: result.error ?? "Unable to cancel this order.", code: "ERROR" };
    } catch (error) {
      if (error instanceof ReservationIntegrityError)
        return { ok: false, error: "Reservation integrity requires review. No changes were committed.", code: "ERROR" };
      throw error;
    }
  }

  // Legacy (COD / pre-managed) orders: same claim discipline as the admin path.
  const updated = await db.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: order.status, version: order.version, paymentFlowVersion: null },
      data: {
        status: "CANCELLED",
        paymentStatus: "CANCELLED",
        version: { increment: 1 },
        cancelledAt: now,
        cancelledBy: cancel.by,
        cancelReason: cancel.reason,
      },
    });
    if (claimed.count !== 1) return false;
    await cancelLegacyOrderInTransaction(tx, order, order.status as OrderStatus);
    // Status history (M-6): the customer cancel is the CANCELLED transition.
    await recordOrderStatusHistory(tx, {
      orderId,
      status: "CANCELLED",
      actor: cancel.by,
      note: cancel.reason,
    });
    return true;
  });

  if (!updated) {
    const fresh = await db.order.findUnique({ where: { id: orderId } });
    if (fresh?.status === "CANCELLED") {
      return {
        ok: true,
        alreadyCancelled: true,
        order: { id: fresh.id, reference: fresh.reference, status: fresh.status, paymentStatus: fresh.paymentStatus },
      };
    }
    return { ok: false, error: "The order changed before it could be cancelled. Please try again.", code: "ERROR" };
  }

  const fresh = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  // Order cancellation email (Chunk 7-final — D14): the cancel just
  // happened in this call, after the transaction committed.
  await enqueueOrderCancelledEmail({ orderId });
  return {
    ok: true,
    order: { id: fresh.id, reference: fresh.reference, status: fresh.status, paymentStatus: fresh.paymentStatus },
  };
}

// ───────────────────────────── Admin (FR-41, BR-11, BR-14) ─────────────────────────────

export interface AdminOrderFilters {
  status?: string;
  /** Payment status (PENDING | PAID | FAILED | REFUNDED | CANCELLED). Unknown
   * values are ignored rather than applied — the list page only ever sends
   * valid ones, and a hand-crafted query param must not empty the list by
   * accident. */
  paymentStatus?: string;
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
      carrier: true,
      trackingNumber: true,
      statusHistory: {
        select: { id: true, status: true, actor: true, note: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      items: {
        select: {
          id: true,
          productName: true,
          variantLabel: true,
          productSlug: true,
          imageUrl: true,
          unitPrice: true,
          quantity: true,
          lineTotal: true,
          giftWrap: true,
        },
      },
      payments: {
        select: {
          id: true,
          provider: true,
          amount: true,
          status: true,
          reference: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
      user: { select: { email: true } },
    },
  });
}

/** Shared WHERE builder for admin order listing AND exports (single source of truth). */
export function adminOrderListWhere(filters: AdminOrderFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.paymentStatus && (PAYMENT_STATUSES as readonly string[]).includes(filters.paymentStatus)) {
    where.paymentStatus = filters.paymentStatus;
  }
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
  /** Machine-readable failure reason for the route's status mapping
   *  (Stage 3 audit, M-4): a missing order is NOT_FOUND → 404, while an
   *  invalid transition stays a bare failure → 409. */
  code?: "NOT_FOUND";
}

/**
 * Order notification after a status change (Chunk 7-final — D14). Called
 * only after the status transaction committed and only on success.
 * CANCELLED notifies the cancellation event; CONFIRMED / PROCESSING /
 * SHIPPED / DELIVERED notify the status event. Best-effort: the
 * notification functions never throw, so a mail problem cannot fail an
 * admin status update.
 */
async function notifyOrderStatusChange(orderId: string, next: OrderStatus): Promise<void> {
  if (next === "CANCELLED") {
    await enqueueOrderCancelledEmail({ orderId });
  } else {
    await enqueueOrderStatusEmail({ orderId, status: next });
  }
}

/**
 * Update order status through the state machine (docs §6).
 * Cancellation from stock-holding statuses restores inventory (BR-11).
 * COD orders delivered → payment PAID (settlement policy).
 * A cancelled order's payment status becomes CANCELLED (D2/M-7) — never
 * PENDING, never FAILED: the unpaid obligation is cancelled, and for a paid
 * managed order the captured payment row stays PAID until a refund settles
 * it (the refund itself stays a manual admin action; D6 is pending, so no
 * provider reversal is attempted anywhere in this function).
 */
export async function adminUpdateOrderStatus(
  orderId: string,
  next: OrderStatus,
  audit?: AdminAuditContext,
  options?: {
    cancelledBy?: string;
    cancelReason?: string | null;
    /** Shipment tracking (D4): applied only when next is SHIPPED. */
    carrier?: string | null;
    trackingNumber?: string | null;
  }
): Promise<StatusUpdateResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) return { ok: false, error: "Order not found.", code: "NOT_FOUND" };

  // Who cancelled, for the Order.cancelledAt/By/Reason record. Defaults to
  // the auditing admin; the customer path passes its own actor explicitly.
  const cancel =
    next === "CANCELLED"
      ? {
          by: options?.cancelledBy ?? (audit ? `admin:${audit.adminUserId}` : "system:unknown"),
          reason: options?.cancelReason ?? null,
        }
      : null;

  // Managed payments must never enter the legacy cancellation/restock/mark-failed branch.
  if (order.paymentFlowVersion !== null) {
    let result: StatusUpdateResult;
    try {
      result = await db.$transaction(
        async (tx) => {
          const result = await updateManagedOrderStatus(
            tx,
            orderId,
            next,
            new Date(),
            cancel ?? undefined,
            { carrier: options?.carrier ?? null, trackingNumber: options?.trackingNumber ?? null }
          );
          if (result.ok) {
            // Status history (M-6): every managed transition gets a dated entry.
            await recordOrderStatusHistory(tx, {
              orderId,
              status: next,
              actor: audit ? `admin:${audit.adminUserId}` : "system",
              note: next === "CANCELLED" ? cancel?.reason ?? null : null,
            });
          }
          if (result.ok && audit) {
            await recordAdminAudit(
              audit,
              {
                action: ADMIN_AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
                targetType: "Order",
                targetId: orderId,
                metadata: {
                  from: order.status,
                  to: next,
                  reference: order.reference,
                  ...(next === "CANCELLED" && cancel
                    ? { cancelledBy: cancel.by, ...(cancel.reason ? { cancelReason: cancel.reason } : {}) }
                    : {}),
                },
              },
              tx
            );
          }
          return result;
        },
        { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 }
      );
    } catch (error) {
      if (error instanceof ReservationIntegrityError)
        return { ok: false, error: "Reservation integrity requires review. No changes were committed." };
      throw error;
    }
    // Order notification (Chunk 7-final — D14): the transition just
    // committed. Paid cancel included — it funnels through this branch.
    if (result.ok) await notifyOrderStatusChange(orderId, next);
    return result;
  }
  if (order.paymentMethod === "ONLINE" && order.paymentStatus !== "PAID" && next !== "CANCELLED")
    return { ok: false, error: "Unpaid online orders cannot be fulfilled." };

  const current = order.status as OrderStatus;
  const allowed = ORDER_STATUS_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    return { ok: false, error: `Cannot move an order from ${current} to ${next}.` };
  }

  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const paymentStatus =
      next === "DELIVERED" && order.paymentMethod === "COD"
        ? "PAID"
        : next === "CANCELLED"
          ? "CANCELLED"
          : order.paymentStatus;

    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: current, version: order.version, paymentFlowVersion: null },
      data: {
        status: next,
        paymentStatus,
        version: { increment: 1 },
        ...(next === "CANCELLED" && cancel
          ? { cancelledAt: now, cancelledBy: cancel.by, cancelReason: cancel.reason }
          : {}),
        // Shipment tracking (D4): stored on the same write as the SHIPPED transition.
        ...(next === "SHIPPED" && options?.carrier ? { carrier: options.carrier } : {}),
        ...(next === "SHIPPED" && options?.trackingNumber ? { trackingNumber: options.trackingNumber } : {}),
      },
    });
    if (claimed.count !== 1) return false;

    // Cancellation restock + coupon release + unpaid-payment cancellation
    // (shared core with the customer path — do not duplicate it here).
    let couponRestored = false;
    if (next === "CANCELLED") {
      ({ couponRestored } = await cancelLegacyOrderInTransaction(tx, order, current));
    }

    if (next === "DELIVERED" && order.paymentMethod === "COD") {
      await tx.payment.updateMany({
        where: { orderId, status: "PENDING" },
        data: { status: "PAID" },
      });
    }
    if (audit) {
      await recordAdminAudit(
        audit,
        {
          action: ADMIN_AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
          targetType: "Order",
          targetId: orderId,
          metadata: {
            from: current,
            to: next,
            reference: order.reference,
            ...(next === "CANCELLED" && order.couponCode
              ? { couponCode: order.couponCode, couponRestored }
              : {}),
            ...(next === "CANCELLED" && cancel
              ? { cancelledBy: cancel.by, ...(cancel.reason ? { cancelReason: cancel.reason } : {}) }
              : {}),
          },
        },
        tx
      );
    }
    // Status history (M-6): every legacy transition gets a dated entry.
    await recordOrderStatusHistory(tx, {
      orderId,
      status: next,
      actor: audit ? `admin:${audit.adminUserId}` : "system",
      note: next === "CANCELLED" ? cancel?.reason ?? null : null,
    });
    return true;
  });

  if (!updated) {
    return { ok: false, error: "The order status changed before this update could be applied." };
  }
  // Order notification (Chunk 7-final — D14): the transition just
  // committed.
  await notifyOrderStatusChange(orderId, next);
  return { ok: true };
}
