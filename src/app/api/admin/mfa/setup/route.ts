// Admin MFA enrollment (PR-10). Starts (or restarts) enrollment: generates a
// fresh TOTP secret, stores it encrypted, and returns the QR code data URL
// plus the manual setup key. MFA is NOT enabled until the admin verifies a
// first code via POST /api/admin/mfa/activate. Re-enrollment replaces the
// pending secret and discards previous recovery codes; the admin must verify
// a code from the new secret to re-enable.
// Rate-limited per admin (3/15min) and per IP (5/15min).
import { requireAdmin } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk } from "@/lib/api";
import { MfaUnavailableError, startAdminMfaEnrollment } from "@/services/admin-mfa.service";

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
      const enrollment = await startAdminMfaEnrollment({ userId: user.id, email: user.email });
      return jsonOk({
        qrCodeDataUrl: enrollment.qrCodeDataUrl,
        manualKey: enrollment.manualKey,
      });
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
