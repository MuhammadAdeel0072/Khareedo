// Admin MFA recovery-code regeneration (PR-10). Deletes all previous
// recovery codes (used and unused) and returns a fresh set — shown to the
// admin once, never stored or logged. Requires MFA to be enabled and the
// session to be MFA-verified, so a stolen password alone cannot rotate the
// codes. Rate-limited per admin (3/15min) and per IP (5/15min).
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk } from "@/lib/api";
import { adminAuditContext } from "@/services/admin-audit.service";
import { regenerateAdminMfaRecoveryCodes } from "@/services/admin-mfa.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireAdminMfaVerified();
    const ip = clientIp(request.headers);
    const ipLimit = rateLimit(`admin-mfa-recovery-ip:${ip}`, 5, 15 * 60 * 1000);
    const userLimit = rateLimit(`admin-mfa-recovery-user:${user.id}`, 3, 15 * 60 * 1000);
    if (!ipLimit.ok || !userLimit.ok) {
      return jsonError("Too many requests. Please try again later.", 429, {
        retryAfterSec: Math.max(ipLimit.retryAfterSec, userLimit.retryAfterSec),
      });
    }
    const recoveryCodes = await regenerateAdminMfaRecoveryCodes(
      user.id,
      adminAuditContext(request, user)
    );
    if (recoveryCodes === null) {
      return jsonError("Administrator MFA is not enabled.", 400);
    }
    return jsonOk({ recoveryCodes });
  });
}
