// Admin MFA activation (PR-10). Verifies a TOTP code and, on success,
// enables MFA and returns the recovery codes — shown to the admin once,
// never stored or logged. The codes are the admin's only fallback if they
// lose their authenticator, so the UI must require the admin to confirm
// they saved them. A failed code does not enable MFA and does not consume
// anything.
//
// Two cases (P1 fix): first-time activation (enables a pending enrollment)
// and replacement activation (a pending replacement secret was started via
// POST /api/admin/mfa/replace after password + current-code
// reauthentication; success atomically swaps the new secret in and rotates
// the recovery codes, keeping MFA enabled). Activating an already-active
// MFA with no pending replacement returns 400 — it must not regenerate
// recovery codes, which would bypass the requireAdminMfaVerified gate of
// the recovery-codes endpoint.
// Rate-limited per admin (5/15min) and per IP (10/15min).
import { z } from "zod";
import { getRequestSession, requireAdmin } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk, parseBody } from "@/lib/api";
import { adminAuditContext } from "@/services/admin-audit.service";
import { MfaUnavailableError, activateAdminMfa } from "@/services/admin-mfa.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireAdmin();
    const parsed = await parseBody(request, bodySchema);
    if (parsed.error) return parsed.error;
    const ip = clientIp(request.headers);
    const ipLimit = rateLimit(`admin-mfa-activate-ip:${ip}`, 10, 15 * 60 * 1000);
    const userLimit = rateLimit(`admin-mfa-activate-user:${user.id}`, 5, 15 * 60 * 1000);
    if (!ipLimit.ok || !userLimit.ok) {
      return jsonError("Too many requests. Please try again later.", 429, {
        retryAfterSec: Math.max(ipLimit.retryAfterSec, userLimit.retryAfterSec),
      });
    }
    try {
      const session = await getRequestSession();
      const recoveryCodes = await activateAdminMfa({
        userId: user.id,
        code: parsed.data.code,
        audit: adminAuditContext(request, user),
        // Binds the activating session when it carries a sid (Phase 2,
        // area B). Undefined for pre-sid sessions: activation still
        // succeeds, and the admin re-verifies after their next sign-in.
        sessionSid: session?.sid,
      });
      if (recoveryCodes === null) {
        return jsonError("That code is not valid. Check your authenticator app and try again.", 400);
      }
      return jsonOk({ recoveryCodes });
    } catch (error) {
      if (error instanceof MfaUnavailableError) {
        return jsonError(
          "Administrator MFA is not configured on this server. Ask the operator to set ADMIN_MFA_ENCRYPTION_KEY.",
          503
        );
      }
      throw error;
    }
  });
}
