// Admin MFA enrollment (PR-10). Starts (or restarts) FIRST-TIME enrollment:
// generates a fresh TOTP secret, stores it encrypted, and returns the QR
// code data URL plus the manual setup key. MFA is NOT enabled until the
// admin verifies a first code via POST /api/admin/mfa/activate.
//
// P1 fix: this endpoint NEVER replaces an already-enabled MFA enrollment.
// A password-only session cannot take over MFA by re-enrolling. When MFA
// is active, startAdminMfaEnrollment throws MfaAlreadyEnabledError and
// this route returns 403; the admin must use POST /api/admin/mfa/replace,
// which requires fresh password + current-code reauthentication and keeps
// the active secret enabled until the replacement is verified.
// Rate-limited per admin (3/15min) and per IP (5/15min).
import { requireAdmin } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk } from "@/lib/api";
import { adminAuditContext } from "@/services/admin-audit.service";
import {
  MfaAlreadyEnabledError,
  MfaUnavailableError,
  startAdminMfaEnrollment,
} from "@/services/admin-mfa.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireAdmin();
    const ip = clientIp(request.headers);
    const ipLimit = rateLimit(`admin-mfa-setup-ip:${ip}`, 5, 15 * 60 * 1000);
    const userLimit = rateLimit(`admin-mfa-setup-user:${user.id}`, 3, 15 * 60 * 1000);
    if (!ipLimit.ok || !userLimit.ok) {
      return jsonError("Too many requests. Please try again later.", 429, {
        retryAfterSec: Math.max(ipLimit.retryAfterSec, userLimit.retryAfterSec),
      });
    }
    try {
      const enrollment = await startAdminMfaEnrollment({
        userId: user.id,
        email: user.email,
        audit: adminAuditContext(request, user),
      });
      return jsonOk({
        qrCodeDataUrl: enrollment.qrCodeDataUrl,
        manualKey: enrollment.manualKey,
      });
    } catch (error) {
      if (error instanceof MfaAlreadyEnabledError) {
        return jsonError(
          "Administrator MFA is already enabled. Use the authenticator replacement flow to change authenticators.",
          403,
          { code: "MFA_ALREADY_ENABLED" }
        );
      }
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
