// Admin email-outbox retry (Phase 3 Chunk 7, H-15). A FAILED outbox row is
// terminal — the worker never retries it automatically — so an admin can
// re-enqueue it here. The retry itself is a conditional update (only a row
// still FAILED is reset), so a double retry cannot resurrect a row that
// already delivered or reset it twice.
import { requireAdminMfaVerified, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { handleRoute } from "@/lib/api";
import { retryEmailOutboxEntry } from "@/services/email-outbox.service";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Stage 3 audit, L-2: wrapped in handleRoute so a non-auth throw
  // becomes a JSON 500 instead of Next.js's default HTML 500 page.
  return handleRoute(async () => {
  try {
    const admin = await requireAdminMfaVerified();

    const limit = rateLimit(`email-outbox-retry:${admin.id}`, 10, 60_000);
    if (!limit.ok) {
      return Response.json(
        { ok: false, code: "RATE_LIMITED" },
        { status: 429, headers: noStore }
      );
    }

    const { id } = await params;
    const retried = await retryEmailOutboxEntry(id);
    if (!retried) {
      return Response.json(
        { ok: false, code: "NOT_FOUND", error: "Outbox entry not found or not failed." },
        { status: 404, headers: noStore }
      );
    }

    await recordAdminAuditBestEffort(adminAuditContext(_request, admin), {
      action: ADMIN_AUDIT_ACTIONS.EMAIL_OUTBOX_RETRIED,
      targetType: "EmailOutbox",
      targetId: id,
    });

    return Response.json({ ok: true, retried: true }, { headers: noStore });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        { ok: false, code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED" },
        { status: error.status, headers: noStore }
      );
    }
    throw error;
  }
  }, _request);
}
