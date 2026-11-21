// Admin MFA disablement (PR-10). Deletes the TOTP secret and all recovery
// codes. Requires reauthentication: the admin's current password AND a
// valid TOTP code or recovery code. A failed password or code leaves MFA
// untouched. Requires the session to be MFA-verified, so a stolen password
// alone cannot disable MFA. Rate-limited per admin (3/15min) and per IP
// (5/15min).
import { z } from "zod";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk, parseBody } from "@/lib/api";
import { adminAuditContext } from "@/services/admin-audit.service";
import { disableAdminMfa, isAdminMfaConfigured } from "@/services/admin-mfa.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1, "Enter your current password."),
  code: z.string().trim().min(6).max(11),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireAdminMfaVerified();
    const parsed = await parseBody(request, bodySchema);
    if (parsed.error) return parsed.error;
    // Config failure is checked BEFORE the limiter: without the key the
    // service can only return false (misleading 400), so answer 503
    // without burning any of the 3 attempts in the budget.
    if (!isAdminMfaConfigured()) {
      return jsonError(
        "Administrator MFA is not configured on this server. Ask the operator to set ADMIN_MFA_ENCRYPTION_KEY.",
        503
      );
    }
    const ip = clientIp(request.headers);
    const ipLimit = rateLimit(`admin-mfa-disable-ip:${ip}`, 5, 15 * 60 * 1000);
    const userLimit = rateLimit(`admin-mfa-disable-user:${user.id}`, 3, 15 * 60 * 1000);
    if (!ipLimit.ok || !userLimit.ok) {
      return jsonError("Too many requests. Please try again later.", 429, {
        retryAfterSec: Math.max(ipLimit.retryAfterSec, userLimit.retryAfterSec),
      });
    }
    const disabled = await disableAdminMfa({
      userId: user.id,
      password: parsed.data.password,
      code: parsed.data.code,
      audit: adminAuditContext(request, user),
    });
    if (!disabled) {
      return jsonError("Your password or code was not correct. MFA has not been disabled.", 400);
    }
    return jsonOk({ message: "Multi-factor authentication has been disabled." });
  });
}
