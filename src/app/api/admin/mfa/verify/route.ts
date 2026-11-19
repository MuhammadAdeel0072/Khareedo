// Admin MFA session verification (PR-10). Verifies a TOTP code or a
// recovery code for the current session, after the admin has signed in with
// their password. On success the session is MFA-verified (lastVerifiedAt is
// recorded) and the admin can reach the admin panel. A recovery code is
// single-use and is consumed on success. A failed code changes nothing.
// This route deliberately uses requireAdmin (role only, not
// requireAdminMfaVerified) so an admin whose session is not yet verified
// can reach it. Rate-limited per admin (5/15min) and per IP (10/15min).
import { z } from "zod";
import { getRequestSession, requireAdmin } from "@/lib/auth-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { handleRoute, jsonError, jsonOk, parseBody } from "@/lib/api";
import { verifyAdminMfaForSession } from "@/services/admin-mfa.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  code: z.string().trim().min(6).max(11),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireAdmin();
    const parsed = await parseBody(request, bodySchema);
    if (parsed.error) return parsed.error;
    const ip = clientIp(request.headers);
    const ipLimit = rateLimit(`admin-mfa-verify-ip:${ip}`, 10, 15 * 60 * 1000);
    const userLimit = rateLimit(`admin-mfa-verify-user:${user.id}`, 5, 15 * 60 * 1000);
    if (!ipLimit.ok || !userLimit.ok) {
      return jsonError("Too many requests. Please try again later.", 429, {
        retryAfterSec: Math.max(ipLimit.retryAfterSec, userLimit.retryAfterSec),
      });
    }
    const session = await getRequestSession();
    // Sessions issued before the sid change carry no session id: the
    // verification cannot be bound to a session, so it fails closed here
    // with a clear message instead of a wrong-code error. The admin signs
    // out and signs in again, which mints a sid.
    if (!session?.sid) {
      return jsonError(
        "Your session was created before a security update. Please sign out and sign in again, then verify.",
        401,
        { code: "SESSION_REBIND_REQUIRED" }
      );
    }
    const result = await verifyAdminMfaForSession({
      userId: user.id,
      code: parsed.data.code,
      sessionIat: session?.iat,
      sessionSid: session.sid,
    });
    if (result === "verified") {
      return jsonOk({ message: "Multi-factor authentication verified." });
    }
    if (result === "not-enrolled") {
      return jsonError("Administrator MFA is not set up. Please set it up first.", 400, {
        code: "MFA_ENROLLMENT_REQUIRED",
      });
    }
    if (result === "unavailable") {
      return jsonError(
        "Administrator MFA is not configured on this server. Ask the operator to set ADMIN_MFA_ENCRYPTION_KEY.",
        503
      );
    }
    return jsonError("That code is not valid. Check your authenticator app or recovery codes and try again.", 400);
  });
}
