import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/postgres-client";
import type { SafepayProvider } from "@/lib/safepay/provider";
import { localId } from "@/lib/safepay/contracts";

// Refund service for the documented Safepay Classic Express Checkout refund endpoint.
//
// Provider facts (verified against official documentation):
// - POST /order/payments/v3/{tracker}/refund, X-SFPY-MERCHANT-SECRET, integer minor units.
// - Full refund → TRACKER_REFUNDED; partial → TRACKER_PARTIAL_REFUND; multiple partial
//   refunds are permitted up to the original amount.
// - Captured within 24h: a REVERSAL may be required instead of a refund. No reversal
//   endpoint is documented for this product line, so in-window requests are parked in
//   REVIEW_REQUIRED instead of submitting an ordinary refund as a substitute.
// - Card refunds have a documented 90-day transaction-completion window. The local schema
//   does not record the underlying payment method, so the 90-day guard parks requests in
//   REVIEW_REQUIRED instead of being applied blindly to unknown methods.
//
// Provider unknowns (deliberately NOT assumed):
// - Idempotency of the refund endpoint is undocumented → duplicate protection is LOCAL
//   (unique operationKey + open-row balance accounting + no automatic resubmission).
// - Individual partial refunds carry no documented provider identifier → webhook amounts
//   are matched FIFO against open rows of exactly that amount; anything else requires
//   review. Cumulative accounting stays correct regardless of attribution.
export type RefundPersistence = Pick<PrismaClient, "$transaction">;

export type RefundRejectionCode =
  | "INVALID_INPUT" | "PAYMENT_NOT_FOUND" | "IDEMPOTENCY_KEY_CONFLICT"
  | "NOT_ONLINE_MANAGED_PAYMENT" | "NOT_REFUNDABLE" | "NOTHING_TO_REFUND"
  | "REFUND_EXCEEDS_REMAINING" | "REFUND_WINDOW_REVERSAL_24H"
  | "REFUND_WINDOW_METHOD_UNVERIFIED" | "REFUND_SUBMIT_OUTCOME_UNKNOWN";

export type RefundSubmissionOutcome =
  | { kind: "submitted"; providerState?: string }
  | { kind: "failed"; code: string; message?: string }
  | { kind: "uncertain"; code: string }
  | { kind: "not_found" }
  | { kind: "invalid_state"; status: string }
  | { kind: "review_required"; reason: string };

export type RefundRequestResult =
  | { kind: "created"; refundId: string; submission: RefundSubmissionOutcome }
  | { kind: "review_required"; refundId: string; reason: string }
  | { kind: "existing"; refundId: string; status: string }
  | { kind: "rejected"; code: RefundRejectionCode; refundId?: string };

export type RefundRow = Prisma.PaymentRefundGetPayload<{ include: { payment: { select: { orderId: true } } } }>;

class RefundSubmitConflict extends Error {}

const operationKeyFor = (idempotencyKey: string) => `ADMIN:${idempotencyKey}`;

export function createPaymentRefundService(
  database: RefundPersistence,
  provider: Pick<SafepayProvider, "submitRefund"> | null,
  options: {
    now?: () => Date;
    environment: string;
    merchantAccountRef: string;
    pollDelayMs: number;
    maxConfirmationAttempts: number;
    submitGraceMs: number;
    reversalWindowMs: number;
    cardRefundWindowMs: number;
  },
) {
  const clock = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(options.pollDelayMs) || options.pollDelayMs < 1_000 || options.pollDelayMs > 86_400_000 ||
      !Number.isSafeInteger(options.maxConfirmationAttempts) || options.maxConfirmationAttempts < 1 ||
      options.maxConfirmationAttempts > 100 ||
      !Number.isSafeInteger(options.submitGraceMs) || options.submitGraceMs < 1_000 || options.submitGraceMs > 86_400_000 ||
      !Number.isSafeInteger(options.reversalWindowMs) || options.reversalWindowMs < 0 ||
      !Number.isSafeInteger(options.cardRefundWindowMs) || options.cardRefundWindowMs < 0) {
    throw new Error("Invalid refund service options.");
  }

  const openStatuses = ["REQUESTED", "SUBMITTING", "PENDING"] as const;

  const guardRefundable = (payment: {
    id: string; status: string; provider: string; providerEnvironment: string | null; merchantAccountRef: string | null;
    currency: string | null; paidVerifiedAt: Date | null; capturedAmountMinor: bigint | null;
    expectedAmountMinor: bigint | null; refundedAmountMinor: bigint | null; trackerToken: string | null;
  } | null, order: { paymentFlowVersion: number | null; paymentMethod: string; currency: string | null;
    paymentStatus: string; acceptedPaymentId: string | null; paymentOwnerOrderId: string | null; id: string } | null) =>
    !!payment && !!order && order.paymentFlowVersion === 1 && order.paymentMethod === "ONLINE" &&
    order.currency === "PKR" && payment.currency === "PKR" && payment.provider === "SAFEPAY" &&
    payment.providerEnvironment === options.environment && payment.merchantAccountRef === options.merchantAccountRef &&
    order.paymentOwnerOrderId === order.id && payment.status === "PAID" && order.paymentStatus === "PAID" &&
    order.acceptedPaymentId === payment.id && !!payment.paidVerifiedAt &&
    payment.capturedAmountMinor !== null && payment.expectedAmountMinor !== null &&
    payment.capturedAmountMinor === payment.expectedAmountMinor && payment.trackerToken !== null;

  return {
    /** Idempotent refund request. The synchronous provider submission happens outside transactions. */
    async requestRefund(input: {
      paymentId: string; amountMinor?: bigint; idempotencyKey?: string; requestedByUserId: string;
    }): Promise<RefundRequestResult> {
      if (!localId.safeParse(input.paymentId).success || !input.requestedByUserId ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestedByUserId) ||
          (input.amountMinor !== undefined && (typeof input.amountMinor !== "bigint" ||
            input.amountMinor <= BigInt(0) || input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER))) ||
          (input.idempotencyKey !== undefined &&
            !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey))) {
        return { kind: "rejected", code: "INVALID_INPUT" };
      }
      const operationKey = input.idempotencyKey ? operationKeyFor(input.idempotencyKey) : null;
      if (operationKey) {
        const existing = await database.$transaction(tx =>
          tx.paymentRefund.findUnique({ where: { operationKey } }));
        if (existing) {
          return existing.paymentId === input.paymentId
            ? { kind: "existing", refundId: existing.id, status: existing.status }
            : { kind: "rejected", code: "IDEMPOTENCY_KEY_CONFLICT" };
        }
      }
      let createdRefundId: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const now = clock();
        try {
          const outcome = await database.$transaction(async tx => {
            const payment = await tx.payment.findUnique({
              where: { id: input.paymentId },
              include: { order: { select: { id: true, paymentFlowVersion: true, paymentMethod: true,
                currency: true, paymentStatus: true, acceptedPaymentId: true, paymentOwnerOrderId: true } } },
            });
            if (!payment) return { kind: "rejected" as const, code: "PAYMENT_NOT_FOUND" as const };
            if (operationKey) {
              const replay = await tx.paymentRefund.findUnique({ where: { operationKey } });
              if (replay) return replay.paymentId === input.paymentId
                ? { kind: "existing" as const, refundId: replay.id, status: replay.status }
                : { kind: "rejected" as const, code: "IDEMPOTENCY_KEY_CONFLICT" as const };
            }
            if (!guardRefundable(payment, payment.order)) {
              return { kind: "rejected" as const, code: "NOT_REFUNDABLE" as const };
            }
            const open = await tx.paymentRefund.findMany({
              where: { paymentId: payment.id, status: { in: [...openStatuses] } },
              select: { amountMinor: true },
            });
            const openSum = open.reduce((sum, row) => sum + row.amountMinor, BigInt(0));
            const captured = payment.capturedAmountMinor!;
            const remaining = captured - (payment.refundedAmountMinor ?? BigInt(0)) - openSum;
            if (remaining <= BigInt(0)) return { kind: "rejected" as const, code: "NOTHING_TO_REFUND" as const };
            const amountMinor = input.amountMinor ?? remaining; // omitted → full remaining balance
            if (amountMinor > remaining) {
              return { kind: "rejected" as const, code: "REFUND_EXCEEDS_REMAINING" as const };
            }
            const ageMs = now.getTime() - payment.paidVerifiedAt!.getTime();
            // Documented 24-hour reversal window: within it a reversal (not an ordinary
            // refund) may be required, and no reversal endpoint exists to call — park.
            if (ageMs < options.reversalWindowMs) return { kind: "review" as const, reason: "REFUND_WINDOW_REVERSAL_24H" };
            // Documented 90-day card window; the local method is unknown, so past the
            // window the request is parked instead of applied blindly to every method.
            if (ageMs >= options.cardRefundWindowMs) return { kind: "review" as const, reason: "REFUND_WINDOW_METHOD_UNVERIFIED" };

            const row = await tx.paymentRefund.create({ data: {
              paymentId: payment.id, trackerToken: payment.trackerToken!,
              providerEnvironment: payment.providerEnvironment!, merchantAccountRef: payment.merchantAccountRef!,
              amountMinor, currency: "PKR", type: amountMinor === remaining ? "FULL" : "PARTIAL",
              status: "REQUESTED", initiatedBy: "ADMIN",
              operationKey: operationKey ?? `AUTO:${randomUUID()}`,
              requestedByUserId: input.requestedByUserId,
            }, select: { id: true } });
            return { kind: "created" as const, refundId: row.id };
          }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
          if (outcome.kind === "created") {
            createdRefundId = outcome.refundId;
            break;
          }
          if (outcome.kind === "review") {
            // Parked requests still get a durable REVIEW_REQUIRED audit row.
            return await this.parkForReview(input, operationKey, outcome.reason, now);
          }
          return outcome;
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
          if ((error instanceof RefundSubmitConflict || code === "P2034" || code === "P2002") && attempt < 2) continue;
          if (code === "P2002") {
            // Unique operationKey race: treat as an idempotent replay.
            if (operationKey) {
              const existing = await database.$transaction(tx =>
                tx.paymentRefund.findUnique({ where: { operationKey } }));
              if (existing && existing.paymentId === input.paymentId) {
                return { kind: "existing", refundId: existing.id, status: existing.status };
              }
            }
            return { kind: "rejected", code: "IDEMPOTENCY_KEY_CONFLICT" };
          }
          if (code === "P2034" || code === "P2028" || code === "P2024") {
            return { kind: "rejected", code: "INVALID_INPUT" };
          }
          return { kind: "rejected", code: "NOT_REFUNDABLE" };
        }
      }
      if (!createdRefundId) return { kind: "rejected", code: "NOT_REFUNDABLE" };
      // The synchronous submission runs OUTSIDE the creation retry loop: a provider crash
      // after the row was claimed must surface as an uncertain submission on a durable
      // SUBMITTING row, never as a fabricated rejection of an existing ledger record.
      const submission = await this.submitRefund(createdRefundId);
      return { kind: "created", refundId: createdRefundId, submission };
    },

    /** Durable REVIEW_REQUIRED audit row for parked requests (reversal/window guards). */
    async parkForReview(
      input: { paymentId: string; amountMinor?: bigint; requestedByUserId: string },
      operationKey: string | null,
      reason: string,
      now: Date,
    ): Promise<RefundRequestResult> {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await database.$transaction(async tx => {
            if (operationKey) {
              const replay = await tx.paymentRefund.findUnique({ where: { operationKey } });
              if (replay) return replay.paymentId === input.paymentId
                ? { kind: "existing" as const, refundId: replay.id, status: replay.status }
                : { kind: "rejected" as const, code: "IDEMPOTENCY_KEY_CONFLICT" as const };
            }
            const payment = await tx.payment.findUnique({
              where: { id: input.paymentId },
              select: { trackerToken: true, providerEnvironment: true, merchantAccountRef: true,
                capturedAmountMinor: true, expectedAmountMinor: true, refundedAmountMinor: true },
            });
            if (!payment || !payment.trackerToken || payment.capturedAmountMinor === null ||
                payment.expectedAmountMinor === null ||
                payment.capturedAmountMinor !== payment.expectedAmountMinor) {
              return { kind: "rejected" as const, code: "NOT_REFUNDABLE" as const };
            }
            const open = await tx.paymentRefund.findMany({
              where: { paymentId: input.paymentId, status: { in: [...openStatuses] } },
              select: { amountMinor: true },
            });
            const openSum = open.reduce((sum, row) => sum + row.amountMinor, BigInt(0));
            const remaining = payment.capturedAmountMinor -
              (payment.refundedAmountMinor ?? BigInt(0)) - openSum;
            const amountMinor = input.amountMinor ?? remaining;
            if (amountMinor <= BigInt(0) || amountMinor > remaining) {
              return { kind: "rejected" as const, code: "REFUND_EXCEEDS_REMAINING" as const };
            }
            const row = await tx.paymentRefund.create({ data: {
              paymentId: input.paymentId, trackerToken: payment.trackerToken,
              providerEnvironment: payment.providerEnvironment!, merchantAccountRef: payment.merchantAccountRef!,
              amountMinor, currency: "PKR", type: amountMinor === remaining ? "FULL" : "PARTIAL",
              status: "REVIEW_REQUIRED", initiatedBy: "ADMIN", reviewReason: reason,
              operationKey: operationKey ?? `AUTO:${randomUUID()}`,
              requestedByUserId: input.requestedByUserId, requestedAt: now,
            }, select: { id: true } });
            return { kind: "review_required" as const, refundId: row.id, reason };
          }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
          if ((code === "P2034" || code === "P2002") && attempt < 2) continue;
          if (code === "P2002" && operationKey) {
            const existing = await database.$transaction(tx =>
              tx.paymentRefund.findUnique({ where: { operationKey } }));
            if (existing && existing.paymentId === input.paymentId) {
              return { kind: "existing", refundId: existing.id, status: existing.status };
            }
          }
          return { kind: "rejected", code: "NOT_REFUNDABLE" };
        }
      }
      return { kind: "rejected", code: "NOT_REFUNDABLE" };
    },

    /**
     * Submit a REQUESTED refund to the provider. The row is claimed (REQUESTED →
     * SUBMITTING, with submittedAt) BEFORE the provider call, so a crash can never lose
     * the fact that a submission may have happened. SUBMITTING rows are never
     * automatically resubmitted — the outcome must be resolved by reconciliation.
     */
    async submitRefund(refundId: string): Promise<RefundSubmissionOutcome> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(refundId)) return { kind: "not_found" };
      let claimed: { id: string; trackerToken: string; amountMinor: bigint; paymentId: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const claimedOrDone = await database.$transaction(async tx => {
            const row = await tx.paymentRefund.findUnique({ where: { id: refundId } });
            if (!row) return { kind: "not_found" as const };
            if (row.status !== "REQUESTED") return { kind: "invalid_state" as const, status: row.status };
            const payment = await tx.payment.findUnique({
              where: { id: row.paymentId },
              select: { status: true, capturedAmountMinor: true, refundedAmountMinor: true },
            });
            const open = await tx.paymentRefund.findMany({
              where: { paymentId: row.paymentId, status: { in: [...openStatuses] }, id: { not: row.id } },
              select: { amountMinor: true },
            });
            const openSum = open.reduce((sum, r) => sum + r.amountMinor, BigInt(0));
            const remaining = (payment?.capturedAmountMinor ?? BigInt(0)) -
              (payment?.refundedAmountMinor ?? BigInt(0)) - openSum;
            // Re-validate against the live ledger: an external refund may have landed
            // between creation and submission.
            if (!payment || payment.status !== "PAID" || row.amountMinor > remaining) {
              if ((await tx.paymentRefund.updateMany({ where: { id: row.id, version: row.version,
                status: "REQUESTED" },
              data: { status: "REVIEW_REQUIRED", reviewReason: "STALE_REFUND_REQUEST",
                version: { increment: 1 } } })).count !== 1) throw new RefundSubmitConflict();
              return { kind: "parked" as const };
            }
            if ((await tx.paymentRefund.updateMany({ where: { id: row.id, version: row.version,
              status: "REQUESTED" },
            data: { status: "SUBMITTING", submittedAt: clock(), version: { increment: 1 } } })).count !== 1) {
              throw new RefundSubmitConflict();
            }
            return { kind: "claimed" as const, id: row.id, trackerToken: row.trackerToken,
              amountMinor: row.amountMinor, paymentId: row.paymentId };
          }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
          if (claimedOrDone.kind === "not_found") return { kind: "not_found" };
          if (claimedOrDone.kind === "invalid_state") return { kind: "invalid_state", status: claimedOrDone.status };
          if (claimedOrDone.kind === "parked") return { kind: "review_required", reason: "STALE_REFUND_REQUEST" };
          claimed = claimedOrDone;
          break;
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
          if ((error instanceof RefundSubmitConflict || code === "P2034") && attempt < 2) continue;
          return { kind: "uncertain", code: "SUBMIT_CLAIM_BUSY" };
        }
      }
      if (!claimed) return { kind: "uncertain", code: "SUBMIT_CLAIM_BUSY" };
      const target = claimed;

      // Provider call: strictly no automatic retries. A transport failure does not prove
      // the refund was not processed; a hard provider-adapter crash is recorded as an
      // equally uncertain outcome on the already-claimed SUBMITTING row.
      if (!provider) return { kind: "uncertain", code: "SUBMIT_PROVIDER_UNAVAILABLE" };
      let outcome: { kind: "submitted"; providerState?: string } |
        { kind: "failed"; code: string; providerMessage?: string } |
        { kind: "uncertain"; code: string } | { kind: "crashed" };
      try {
        const call = await provider.submitRefund({ trackerToken: target.trackerToken, amountMinor: target.amountMinor });
        outcome = call.kind === "submitted" ? { kind: "submitted", providerState: call.providerState }
          : call.kind === "failed" ? { kind: "failed", code: call.code, providerMessage: call.providerMessage }
          : { kind: "uncertain", code: call.code };
      } catch {
        outcome = { kind: "crashed" };
      }
      const now = clock();
      await database.$transaction(async tx => {
        const fresh = await tx.paymentRefund.findUnique({ where: { id: target.id } });
        if (!fresh || fresh.status !== "SUBMITTING") return; // finalized elsewhere; never overwrite
        if (outcome.kind === "submitted") {
          await tx.paymentRefund.updateMany({ where: { id: target.id, status: "SUBMITTING" },
            data: { status: "PENDING", submittedAt: now, providerState: outcome.providerState ?? null,
              lastSubmissionCode: null, reconcileStatus: "PENDING",
              nextReconcileAt: new Date(now.getTime() + options.pollDelayMs), version: { increment: 1 } } });
        } else if (outcome.kind === "failed") {
          await tx.paymentRefund.updateMany({ where: { id: target.id, status: "SUBMITTING" },
            data: { status: "FAILED", submittedAt: now, failureCode: outcome.code,
              failureMessage: outcome.providerMessage ?? null, nextReconcileAt: null, version: { increment: 1 } } });
        } else {
          // Uncertain outcome (timeout, network error, 5xx, adapter crash): pending
          // confirmation from authenticated evidence or bounded reconciliation polling.
          // Never a retry.
          await tx.paymentRefund.updateMany({ where: { id: target.id, status: "SUBMITTING" },
            data: { status: "PENDING", submittedAt: now,
              lastSubmissionCode: outcome.kind === "crashed" ? "SUBMIT_CRASHED" : outcome.code,
              reconcileStatus: "PENDING", nextReconcileAt: new Date(now.getTime() + options.pollDelayMs),
              version: { increment: 1 } } });
        }
      });
      if (outcome.kind === "submitted") return { kind: "submitted", providerState: outcome.providerState };
      if (outcome.kind === "failed") {
        return { kind: "failed", code: outcome.code, message: outcome.providerMessage };
      }
      if (outcome.kind === "uncertain") return { kind: "uncertain", code: outcome.code };
      if (outcome.kind === "crashed") return { kind: "uncertain", code: "SUBMIT_CRASHED" };
      return { kind: "uncertain", code: "PROVIDER_CALL_UNCLASSIFIED" };
    },

    /** Bounded work discovery for the maintenance worker. Never submits duplicates blindly. */
    async dueForReconciliation(limit = 25) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid refund batch size.");
      const now = clock();
      const staleBefore = new Date(now.getTime() - options.submitGraceMs);
      return database.$transaction(tx => tx.paymentRefund.findMany({
        where: {
          providerEnvironment: options.environment, merchantAccountRef: options.merchantAccountRef,
          OR: [
            { status: "REQUESTED", OR: [{ nextReconcileAt: null }, { nextReconcileAt: { lte: now } }] },
            { status: "SUBMITTING", submittedAt: { lte: staleBefore } },
            { status: "PENDING", nextReconcileAt: { lte: now } },
          ],
        },
        orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
        take: limit,
        select: { id: true, status: true, paymentId: true, trackerToken: true, amountMinor: true,
          submittedAt: true, reconcileAttempts: true, version: true },
      }));
    },

    /** A stale SUBMITTING row has an unknown provider outcome: review, never resubmit. */
    async abandonStaleSubmission(refundId: string): Promise<"parked" | "unchanged"> {
      const now = clock();
      const result = await database.$transaction(tx => tx.paymentRefund.updateMany({
        where: { id: refundId, status: "SUBMITTING" },
        data: { status: "REVIEW_REQUIRED", reviewReason: "SUBMIT_OUTCOME_UNKNOWN", reconcileStatus: "REVIEW_REQUIRED",
          nextReconcileAt: null, lastReconcileAt: now, version: { increment: 1 } },
      }));
      return result.count === 1 ? "parked" : "unchanged";
    },

    /** Record one bounded confirmation attempt for a PENDING row; exhausts into review. */
    async noteReconcileAttempt(refundId: string): Promise<"PENDING" | "REVIEW_REQUIRED" | "FINALIZED"> {
      const now = clock();
      return database.$transaction(async tx => {
        const row = await tx.paymentRefund.findUnique({ where: { id: refundId }, select: { status: true, version: true } });
        if (!row) return "FINALIZED" as const;
        if (row.status !== "PENDING") return "FINALIZED" as const;
        const attempts = await tx.paymentRefund.updateMany({ where: { id: refundId, version: row.version,
          status: "PENDING" },
        data: { reconcileAttempts: { increment: 1 }, lastReconcileAt: now, reconcileStatus: "PENDING",
          nextReconcileAt: new Date(now.getTime() + options.pollDelayMs), version: { increment: 1 } } });
        if (attempts.count !== 1) return "FINALIZED" as const;
        const fresh = await tx.paymentRefund.findUnique({ where: { id: refundId },
          select: { reconcileAttempts: true, version: true } });
        if (fresh && fresh.reconcileAttempts >= options.maxConfirmationAttempts) {
          await tx.paymentRefund.updateMany({ where: { id: refundId, version: fresh.version, status: "PENDING" },
            data: { status: "REVIEW_REQUIRED", reviewReason: "CONFIRMATION_TIMEOUT", reconcileStatus: "REVIEW_REQUIRED",
              nextReconcileAt: null, version: { increment: 1 } } });
          return "REVIEW_REQUIRED" as const;
        }
        return "PENDING" as const;
      });
    },

    /** Refund history for admin monitoring. Ids only route through server-owned relations. */
    async listRefunds(filter: { paymentId?: string; orderId?: string; status?: string }, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid refund list size.");
      if (filter.paymentId && !localId.safeParse(filter.paymentId).success) return [];
      if (filter.orderId && !localId.safeParse(filter.orderId).success) return [];
      if (filter.status && !["REQUESTED", "SUBMITTING", "PENDING", "SUCCEEDED", "FAILED", "REVIEW_REQUIRED"]
        .includes(filter.status)) return [];
      return database.$transaction(tx => tx.paymentRefund.findMany({
        where: {
          ...(filter.paymentId ? { paymentId: filter.paymentId } : {}),
          ...(filter.orderId ? { payment: { orderId: filter.orderId } } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit,
        include: { payment: { select: { orderId: true, trackerToken: true, status: true } } },
      }));
    },

    async getRefund(refundId: string) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(refundId)) return null;
      return database.$transaction(tx => tx.paymentRefund.findUnique({
        where: { id: refundId },
        include: { payment: { select: { orderId: true, trackerToken: true, status: true,
          providerEnvironment: true, merchantAccountRef: true } } },
      }));
    },
  };
}

export type PaymentRefundService = ReturnType<typeof createPaymentRefundService>;
