// Password reset request (PR-09, security-review fix). Enumeration-safe:
// the response is identical whether or not an eligible account exists for
// the email, so the endpoint cannot be used to probe which emails are
// registered. This is achieved structurally, not just by identical text:
// the handler enqueues exactly one outbox row — the same single DB write
// for every address — and returns immediately. It never sends email
// synchronously (a registered account used to do a DB write plus an SMTP
// round-trip while an unknown address returned in milliseconds, and an SMTP
// failure used to surface as a 503 for a registered account versus a 200
// for an unknown one). A background worker delivers the email; SMTP
// failures happen there, are retried with backoff, and never reach this
// response. This handler therefore never checks SMTP configuration.
import { createHash } from "node:crypto";
import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { emailSchema } from "@/lib/validation";
import { requestPasswordReset } from "@/services/password-reset.service";

const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export async function POST(request: Request) {
  const parsed = await parseBody(request, forgotPasswordSchema);
  if (parsed.error) return parsed.error;

  const ip = clientIp(request.headers);
  const emailKey = createHash("sha256").update(parsed.data.email).digest("hex");
  const ipLimit = rateLimit(`password-reset-request-ip:${ip}`, 10, 15 * 60 * 1000);
  const emailLimit = rateLimit(`password-reset-request-email:${emailKey}`, 3, 60 * 60 * 1000);
  if (!ipLimit.ok || !emailLimit.ok) {
    return jsonError("Too many requests. Please try again later.", 429, {
      retryAfterSec: Math.max(ipLimit.retryAfterSec, emailLimit.retryAfterSec),
    });
  }

  try {
    await requestPasswordReset(parsed.data.email);
    // Same message whether or not an account exists — never reveal it.
    return jsonOk({ message: "If an account exists for this email address, a password reset link has been sent." });
  } catch (error) {
    console.error("[auth] password reset request failed", error instanceof Error ? error.name : "UnknownError");
    return jsonError("Unable to send a password reset email. Please try again later.", 500);
  }
}
