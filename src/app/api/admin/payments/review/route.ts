import { z } from "zod";
import { requireAdminMfaVerified, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import {
  createPaymentReviewService,
  listPaymentReviewCases,
  type ResolvePaymentReviewHoldResult,
} from "@/services/payment-review.service";
import { adminAuditContext } from "@/services/admin-audit.service";
import { handleRoute, readBoundedBodyText } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

const resolveSchema = z
  .object({
    orderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    outcome: z.enum(["NOT_CAPTURED", "CAPTURED"]),
  })
  .strict();

const RESOLVE_ERROR_STATUS: Record<
  Exclude<ResolvePaymentReviewHoldResult, { ok: true }>["code"],
  number
> = {
  NOT_ELIGIBLE: 409,
  // Stage 3 audit, L-3: resolving a nonexistent order is 404, not 409.
  ORDER_NOT_FOUND: 404,
  INVESTIGATION_REQUIRED: 409,
  CAPTURE_EVIDENCE_PRESENT: 409,
  CAPTURE_EVIDENCE_REQUIRED: 409,
  CAPTURE_AMOUNT_MISMATCH: 409,
  RESERVATION_MISMATCH: 409,
  ORDER_CHANGED: 409,
};

export async function GET(request?: Request) {
  // Stage 3 audit, L-2: wrapped in handleRoute so a non-auth throw
  // becomes a JSON 500 instead of Next.js's default HTML 500 page.
  return handleRoute(async () => {
  try {
    const admin = await requireAdminMfaVerified();

    const limit = rateLimit(`payments-review:${admin.id}`, 30, 60_000);

    if (!limit.ok) {
      return Response.json(
        { ok: false, code: "RATE_LIMITED" },
        { status: 429, headers: noStore }
      );
    }

    const cases = await listPaymentReviewCases();

    return Response.json(
      {
        ok: true,
        cases: cases.map((c) => ({
          orderId: c.orderId,
          reference: c.reference,
          orderStatus: c.orderStatus,
          paymentStatus: c.paymentStatus,
          reviewReason: c.reviewReason,
          closeReason: c.closeReason,
          closedAt: c.closedAt,
          reservationExpiresAt: c.reservationExpiresAt,
          investigated: c.investigated,
          captureEvidence: c.captureEvidence,
        })),
      },
      { headers: noStore }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        {
          ok: false,
          code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        },
        { status: error.status, headers: noStore }
      );
    }

    throw error;
  }
  }, request);
}

/**
 * Resolve one REQUIRED payment-review hold (H-13). The provider outcome must
 * already be verified — see payment-review.service.ts. The resolution itself
 * is recorded in the admin audit log (atomically, inside the same
 * transaction) so a resolved hold always leaves a trace.
 */
export async function POST(request: Request) {
  // Stage 3 audit, L-2: same handleRoute wrap as GET (JSON 500, not HTML).
  return handleRoute(async () => {
  try {
    const admin = await requireAdminMfaVerified();

    const limit = rateLimit(`payments-review-resolve:${admin.id}`, 10, 60_000);
    if (!limit.ok) {
      return Response.json(
        { ok: false, code: "RATE_LIMITED" },
        { status: 429, headers: noStore }
      );
    }

    // Stage 3 audit, L-5: the body is read under parseBody's 1 MiB cap
    // (the old request.json() had no cap). The error contract is
    // unchanged: unparseable → 400 INVALID_BODY, oversized → 413.
    const read = await readBoundedBodyText(request);
    if (!read.ok && read.reason === "too-large") {
      return Response.json(
        { ok: false, code: "BODY_TOO_LARGE", error: "Request body is too large." },
        { status: 413, headers: noStore }
      );
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(read.ok ? read.text : "");
    } catch {
      return Response.json(
        { ok: false, code: "INVALID_BODY", error: "Invalid request body." },
        { status: 400, headers: noStore }
      );
    }
    const parsed = resolveSchema.safeParse(parsedBody);
    if (!parsed.success) {
      return Response.json(
        {
          ok: false,
          code: "INVALID_INPUT",
          error: "Please correct the highlighted fields.",
          errors: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 422, headers: noStore }
      );
    }

    const service = createPaymentReviewService();
    const result = await service.resolvePaymentReviewHold(
      parsed.data.orderId,
      parsed.data.outcome,
      adminAuditContext(request, admin)
    );
    if (!result.ok) {
      return Response.json(
        { ok: false, code: result.code },
        { status: RESOLVE_ERROR_STATUS[result.code], headers: noStore }
      );
    }
    return Response.json(
      {
        ok: true,
        outcome: result.outcome,
        ...(result.paymentId ? { paymentId: result.paymentId } : {}),
      },
      { headers: noStore }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        {
          ok: false,
          code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        },
        { status: error.status, headers: noStore }
      );
    }

    throw error;
  }
  }, request);
}
