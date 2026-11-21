// Order status history — dated timeline of order status transitions (Phase 3,
// Chunk 6 — M-6/D4). Written in the same transaction as the status change so
// the timeline can never disagree with the order row. Append-only: there is
// no update or delete API for these rows.
import { db } from "@/lib/db";

/** Minimal transaction surface: accepts both the plain Prisma client and the
 * app's $extends-wrapped client (same workaround as the other services —
 * the extended client is not structurally assignable to the plain
 * TransactionClient, so the helper asks only for the delegate it uses). */
export type StatusHistoryWriter = {
  orderStatusHistory: {
    create: (args: {
      data: {
        orderId: string;
        status: string;
        actor: string | null;
        note: string | null;
        createdAt?: Date;
      };
    }) => Promise<unknown>;
  };
};

export interface RecordStatusHistoryInput {
  orderId: string;
  /** PENDING | CONFIRMED | PROCESSING | SHIPPED | DELIVERED | CANCELLED. */
  status: string;
  /** "admin:<id>" | "customer:<id>" | "system" | "system:expiry". Null when unknown. */
  actor?: string | null;
  /** Free text where the transition already records one (e.g. cancel reason). */
  note?: string | null;
  /** Defaults to now; pass explicitly only when the transition has its own timestamp. */
  createdAt?: Date;
}

export async function recordOrderStatusHistory(
  tx: StatusHistoryWriter,
  input: RecordStatusHistoryInput
): Promise<void> {
  await tx.orderStatusHistory.create({
    data: {
      orderId: input.orderId,
      status: input.status,
      actor: input.actor ?? null,
      note: input.note ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

/** Dated timeline for one order, oldest first. */
export async function getOrderStatusHistory(orderId: string) {
  return db.orderStatusHistory.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, status: true, actor: true, note: true, createdAt: true },
  });
}
