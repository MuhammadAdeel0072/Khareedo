// Admin email-outbox delivery (Phase 3 Chunk 7, M-23). On-demand sweep of
// due outbox rows for deployments where the in-process worker does not run
// (serverless): an admin can trigger exactly the same delivery the worker
// performs. Protection mirrors the admin payments-maintenance endpoint: an
// admin MFA-verified session is mandatory, plus a per-admin rate limit.
// There is no separate cron token here — the maintenance endpoint's shared
// token is Safepay-specific and does not transfer to email. Concurrency
// with the worker is safe: rows are claimed atomically inside
// deliverPendingOutboxEmails, so a row is delivered at most once even if
// this route and the worker sweep at the same time.
import { z } from "zod";
import { requireAdminMfaVerified, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";
import { deliverPendingOutboxEmails } from "@/services/email-outbox.service";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    batch: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export async function POST(request: Request) {
  // Stage 3 audit, L-2: wrapped in handleRoute so a non-auth throw
  // becomes a JSON 500 instead of Next.js's default HTML 500 page.
  return handleRoute(async () => {
  try {
    const admin = await requireAdminMfaVerified();

    const limit = rateLimit(`email-outbox-deliver:${admin.id}`, 10, 60_000);
    if (!limit.ok) {
      return Response.json(
        { ok: false, code: "RATE_LIMITED", error: `Too many delivery calls. Retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Cache-Control": "no-store" } }
      );
    }

    const parsed = await parseBody(request, bodySchema);
    if (parsed.error) return parsed.error;
    const { batch = 10 } = parsed.data;

    const result = await deliverPendingOutboxEmails(batch);
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.EMAIL_OUTBOX_DELIVERY_RUN,
      targetType: "EmailOutbox",
      metadata: { batch, ...result },
    });

    const response = jsonOk(result);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        { ok: false, code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED" },
        { status: error.status, headers: { "Cache-Control": "no-store" } }
      );
    }
    throw error;
  }
  }, request);
}
