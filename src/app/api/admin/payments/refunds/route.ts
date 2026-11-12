// Admin refund API — initiate and monitor Safepay refunds for managed payments.
// Authorization mirrors the existing admin payment maintenance surface: an ADMIN
// session is mandatory, amounts are validated exclusively server-side from the
// stored payment ledger, and the provider submission is sandbox-scoped by a code
// gate (SAFEPAY_REFUNDS_SANDBOX_ONLY) that no request input can widen.
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonOk, handleRoute } from "@/lib/api";
import { loadSafepayConfig, SafepayConfigurationError } from "@/lib/safepay/config";
import { requestOrigin } from "@/lib/request-origin";
import { createSafepayProvider } from "@/lib/safepay/provider";
import { createPaymentRefundService } from "@/services/payment-refund.service";
import { SAFEPAY_REFUNDS_SANDBOX_ONLY } from "@/lib/safepay/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const initiateSchema = z.object({
  paymentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  // Minor units (1 PKR = 100). Omitted → full refund of the remaining refundable balance.
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  // Optional client-side idempotency key; replaying it returns the original operation.
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
}).strict();

const listSchema = z.object({
  paymentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  orderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  status: z.enum(["REQUESTED", "SUBMITTING", "PENDING", "SUCCEEDED", "FAILED", "REVIEW_REQUIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const REFUND_SERVICE_OPTIONS = {
  pollDelayMs: 60_000, maxConfirmationAttempts: 6, submitGraceMs: 120_000,
  reversalWindowMs: 24 * 3_600_000, cardRefundWindowMs: 90 * 24 * 3_600_000,
} as const;

type SerializableRefundRow = {
  id: string; paymentId: string; amountMinor: bigint; currency: string; type: string; status: string;
  initiatedBy: string; providerState: string | null; providerReference: string | null;
  providerRefundedAt: Date | null; failureCode: string | null; failureMessage: string | null;
  lastSubmissionCode: string | null; reviewReason: string | null; requestedByUserId: string | null;
  requestedAt: Date; submittedAt: Date | null; confirmedAt: Date | null; settledAt: Date | null;
  reconcileStatus: string | null; reconcileAttempts: number; version: number;
  payment: { orderId: string };
};

// Serialized rows never include merchant secrets or raw provider payloads: the ledger
// carries sanitized codes/messages only (sanitization happens in the provider adapter).
function serialize(row: SerializableRefundRow) {
  return {
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
  };
}

export async function POST(request: Request) {
  try {
    const user = await requireAdmin();
    const limit = rateLimit(`payments-refunds-initiate:${user.id}`, 10, 60_000);
    if (!limit.ok) {
      return Response.json({ ok: false, code: "RATE_LIMITED",
        error: `Too many refund requests. Retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    let config;
    try {
      config = loadSafepayConfig(process.env, requestOrigin(request.headers) ?? undefined);
    } catch (error) {
      if (!(error instanceof SafepayConfigurationError)) throw error;
      return Response.json({ ok: false, code: "SAFEPAY_CONFIGURATION_UNAVAILABLE",
        error: "Safepay server configuration is incomplete." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (SAFEPAY_REFUNDS_SANDBOX_ONLY && config.environment !== "sandbox") {
      // Hard code gate: refunds are implemented and verified for sandbox only.
      return Response.json({ ok: false, code: "REFUNDS_SANDBOX_ONLY",
        error: "Refunds are not enabled outside the sandbox." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    let parsedBody: unknown;
    try { parsedBody = await request.json(); } catch {
      return Response.json({ ok: false, code: "INVALID_BODY", error: "Invalid request body." },
        { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const parsed = initiateSchema.safeParse(parsedBody);
    if (!parsed.success) {
      return Response.json({ ok: false, code: "INVALID_INPUT", error: "Please correct the highlighted fields.",
        errors: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) },
        { status: 422, headers: { "Cache-Control": "no-store" } });
    }
    const provider = createSafepayProvider(config);
    const refunds = createPaymentRefundService(db as never, provider, {
      environment: config.environment, merchantAccountRef: config.merchantAccountRef, ...REFUND_SERVICE_OPTIONS,
    });
    const result = await refunds.requestRefund({
      paymentId: parsed.data.paymentId,
      ...(parsed.data.amountMinor !== undefined ? { amountMinor: BigInt(parsed.data.amountMinor) } : {}),
      ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
      requestedByUserId: user.id,
    });
    if (result.kind === "rejected") {
      const status = result.code === "PAYMENT_NOT_FOUND" || result.code === "INVALID_INPUT" ? 404 : 409;
      return Response.json({ ok: false, code: result.code, error: "Refund request was not accepted." },
        { status, headers: { "Cache-Control": "no-store" } });
    }
    const row = await refunds.getRefund(result.refundId);
    return Response.json({ ok: true,
      result: { kind: result.kind,
        ...(result.kind === "created" ? { submission: result.submission } : {}),
        ...(result.kind === "review_required" ? { reason: result.reason } : {}) },
      refund: row ? serialize(row) : null },
      { status: result.kind === "created" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ ok: false, code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireAdmin();
    const limit = rateLimit(`payments-refunds-list:${user.id}`, 30, 60_000);
    if (!limit.ok) {
      return Response.json({ ok: false, code: "RATE_LIMITED",
        error: `Too many list requests. Retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    const url = new URL(request.url);
    const raw = Object.fromEntries([...url.searchParams.entries()]
      .filter(([key]) => ["paymentId", "orderId", "status", "limit"].includes(key)));
    const parsed = listSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ ok: false, code: "INVALID_INPUT", error: "Invalid refund list filters." },
        { status: 422, headers: { "Cache-Control": "no-store" } });
    }
    // Read-only usage: no provider is injected, submissions are structurally impossible.
    const refunds = createPaymentRefundService(db as never, null, {
      environment: "sandbox", merchantAccountRef: "read-only", ...REFUND_SERVICE_OPTIONS,
    });
    const rows = await refunds.listRefunds({
      ...(parsed.data.paymentId ? { paymentId: parsed.data.paymentId } : {}),
      ...(parsed.data.orderId ? { orderId: parsed.data.orderId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
    }, parsed.data.limit ?? 50);
    return jsonOk({ refunds: rows.map(serialize) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ ok: false, code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
