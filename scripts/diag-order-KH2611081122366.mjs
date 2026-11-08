// Read-only diagnostic for the reported stuck sandbox order. Prints no secrets,
// masks tracker tokens, modifies nothing.
import { PrismaClient } from "../generated/postgres-client/index.js";

// .env stores DATABASE_URL quoted; Node --env-file keeps the quotes, dotenv strips them.
if (process.env.DATABASE_URL?.startsWith('"')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/^"(.*)"$/s, "$1");
}
const db = new PrismaClient();
const REF = process.argv[2] ?? "KH2611081122366";

const mask = (t) => (t ? `${t.slice(0, 6)}…(${t.length} chars)` : null);

try {
  const order = await db.order.findFirst({
    where: { reference: REF },
    select: {
      id: true, reference: true, status: true, paymentStatus: true, paymentMethod: true,
      paymentFlowVersion: true, checkoutClosedAt: true, checkoutCloseReason: true,
      acceptedPaymentId: true, activePaymentId: true, paymentReviewStatus: true,
      paymentReviewReason: true, reservationExpiresAt: true, checkoutAccessExpiresAt: true,
      createdAt: true, total: true, currency: true, userId: true, isGuest: true,
    },
  });
  if (!order) { console.log("ORDER NOT FOUND:", REF); process.exit(0); }
  console.log("ORDER:", JSON.stringify({
    ...order, id: order.id, userId: order.userId ? "<set>" : null,
  }, null, 2));

  const payments = await db.payment.findMany({
    where: { orderId: order.id },
    orderBy: { attemptNumber: "asc" },
    select: {
      id: true, provider: true, status: true, amount: true, currency: true,
      attemptNumber: true, attemptState: true, providerEnvironment: true,
      trackerToken: true, providerState: true, reconcileStatus: true,
      lastErrorCode: true, creationStartedAt: true, trackerBoundAt: true,
      paidVerifiedAt: true, nextReconcileAt: true, lastReconcileAt: true,
      reconcileAttempts: true, expectedAmountMinor: true, capturedAmountMinor: true,
      refundedAmountMinor: true, createdAt: true, updatedAt: true,
    },
  });
  for (const p of payments) {
    console.log("PAYMENT:", JSON.stringify({ ...p, id: p.id, trackerToken: mask(p.trackerToken) }, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  }

  if (payments[0]) {
    const evidence = await db.paymentEvidence.findMany({
      where: { paymentId: payments[0].id },
      orderBy: { createdAt: "asc" },
      select: { source: true, operation: true, validationStatus: true, decision: true, reasonCode: true, createdAt: true },
    });
    console.log("EVIDENCE ROWS:", evidence.length);
    for (const e of evidence) console.log("  EVIDENCE:", JSON.stringify(e));
  }

  const events = await db.paymentWebhookEvent.findMany({
    where: { trackerToken: payments[0]?.trackerToken ?? "__none__" },
    select: {
      id: true, processingStatus: true, reviewRequired: true, reviewReason: true,
      deliveryCount: true, firstReceivedAt: true, lastReceivedAt: true, processedAt: true,
      eventType: true, providerEventId: true,
    },
  });
  console.log("WEBHOOK EVENTS for tracker:", events.length);
  for (const e of events) console.log("  EVENT:", JSON.stringify({ ...e, id: e.id, providerEventId: e.providerEventId ? "<set>" : null }));

  const pendingCount = await db.payment.count({
    where: { provider: "SAFEPAY", status: "PENDING", trackerToken: { not: null } },
  });
  const reviewCount = await db.order.count({ where: { paymentReviewStatus: "REQUIRED" } });
  console.log("SAFEPAY PENDING payments with bound tracker:", pendingCount);
  console.log("Orders with paymentReviewStatus=REQUIRED:", reviewCount);
} finally {
  await db.$disconnect();
}
