// Admin MFA replacement enrollment (PR-10, P1 fix). Starts a replacement
// for an ALREADY-ACTIVE MFA enrollment: generates a fresh TOTP secret,
// stores it as a PENDING replacement, and returns the QR code data URL
// plus the manual setup key. The active secret, enabledAt, and recovery
// codes are preserved until the replacement is verified via
// POST /api/admin/mfa/activate, which atomically swaps the new secret in.
// A failed or abandoned replacement never disables MFA or invalidates the
// active secret or codes.
//
// Requires BOTH:
// - an MFA-verified session (requireAdminMfaVerified), and
// - fresh reauthentication in the body: the current password AND a valid
//   current TOTP code or recovery code.
// A password-only session therefore cannot replace active MFA, and a
// stolen verified session alone is not enough either.
// Rate-limited per admin (5/15min) and per IP (10/15min).
import { z } from "zod";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk, parseBody } from "@/lib/api";
import { adminAuditContext } from "@/services/admin-audit.service";
import { MfaUnavailableError, isAdminMfaConfigured, startAdminMfaReplacement } from "@/services/admin-mfa.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1, "Enter your current password."),
  code: z
    .string()
    .trim()
    .min(6, "Enter the 6-digit code from your authenticator app, or a recovery code.")
    .max(11, "Enter the 6-digit code from your authenticator app, or a recovery code."),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireAdminMfaVerified();
    const parsed = await parseBody(request, bodySchema);
    if (parsed.error) return parsed.error;
    // Config failure is checked BEFORE the limiter: a missing key must
    // return 503 without burning any of the 5 attempts in the budget.
    if (!isAdminMfaConfigured()) {
      return jsonError(
        "Administrator MFA is not configured on this server. Ask the operator to set ADMIN_MFA_ENCRYPTION_KEY.",
        503
      );
    }
    const ip = clientIp(request.headers);
    const ipLimit = rateLimit(`admin-mfa-replace-ip:${ip}`, 10, 15 * 60 * 1000);
    const userLimit = rateLimit(`admin-mfa-replace-user:${user.id}`, 5, 15 * 60 * 1000);
    if (!ipLimit.ok || !userLimit.ok) {
      return jsonError("Too many requests. Please try again later.", 429, {
        retryAfterSec: Math.max(ipLimit.retryAfterSec, userLimit.retryAfterSec),
      });
    }
    try {
      const replacement = await startAdminMfaReplacement({
        userId: user.id,
        email: user.email,
        password: parsed.data.password,
        code: parsed.data.code,
        audit: adminAuditContext(request, user),
      });
      if (replacement === null) {
        return jsonError(
          "Your password or current code is not valid, or MFA is not enabled. Check both and try again.",
          400
        );
      }
      return jsonOk({
        qrCodeDataUrl: replacement.qrCodeDataUrl,
        manualKey: replacement.manualKey,
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
