// Admin refund status — read-only view of one refund ledger operation.
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonOk, handleRoute } from "@/lib/api";
import { createPaymentRefundService } from "@/services/payment-refund.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFUND_SERVICE_OPTIONS = {
  pollDelayMs: 60_000, maxConfirmationAttempts: 6, submitGraceMs: 120_000,
  reversalWindowMs: 24 * 3_600_000, cardRefundWindowMs: 90 * 24 * 3_600_000,
} as const;

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAdmin();
    const limit = rateLimit(`payments-refunds-status:${user.id}`, 60, 60_000);
    if (!limit.ok) {
      return Response.json({ ok: false, code: "RATE_LIMITED",
        error: `Too many status requests. Retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    const { id } = await ctx.params;
    // Read-only usage: no provider is injected, submissions are structurally impossible.
    const refunds = createPaymentRefundService(db as never, null, {
      environment: "sandbox", merchantAccountRef: "read-only", ...REFUND_SERVICE_OPTIONS,
    });
    const row = await refunds.getRefund(id);
    if (!row) {
      return Response.json({ ok: false, code: "REFUND_NOT_FOUND", error: "Refund not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return jsonOk({ refund: {
      id: row.id, paymentId: row.paymentId, orderId: row.payment.orderId,
      amountMinor: row.amountMinor.toString(), currency: row.currency,
      type: row.type, status: row.status, initiatedBy: row.initiatedBy,
      providerState: row.providerState, providerReference: row.providerReference,
      providerRefundedAt: row.providerRefundedAt, failureCode: row.failureCode,
      failureMessage: row.failureMessage, lastSubmissionCode: row.lastSubmissionCode,
      reviewReason: row.reviewReason, requestedByUserId: row.requestedByUserId,
      requestedAt: row.requestedAt, submittedAt: row.submittedAt,
      confirmedAt: row.confirmedAt, settledAt: row.settledAt,
      reconcileStatus: row.reconcileStatus, reconcileAttempts: row.reconcileAttempts,
      version: row.version,
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ ok: false, code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
