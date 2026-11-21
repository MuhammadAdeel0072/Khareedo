import { createHash } from "node:crypto";
import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { emailSchema } from "@/lib/validation";
import { resendVerificationEmail } from "@/services/email-verification.service";

const resendSchema = z.object({
  email: emailSchema,
  callbackUrl: z.string().max(2048).optional(),
});

export async function POST(request: Request) {
  const parsed = await parseBody(request, resendSchema);
  if (parsed.error) return parsed.error;

  const ip = clientIp(request.headers);
  const emailKey = createHash("sha256").update(parsed.data.email).digest("hex");
  const ipLimit = rateLimit(`verify-resend-ip:${ip}`, 10, 15 * 60 * 1000);
  const emailLimit = rateLimit(`verify-resend-email:${emailKey}`, 3, 60 * 60 * 1000);
  if (!ipLimit.ok || !emailLimit.ok) {
    return jsonError("Too many requests. Please try again later.", 429, {
      retryAfterSec: Math.max(ipLimit.retryAfterSec, emailLimit.retryAfterSec),
    });
  }

  try {
    // Resend only enqueues a verification email in the outbox (Phase 3
    // Chunk 7, M-24) — the worker looks the account up at delivery and
    // silently discards unknown, OAuth-only, and already-verified
    // addresses, so the response is identical either way. There is no
    // SMTP-configuration failure to report here: a failed delivery shows
    // up as a FAILED outbox row for an admin to retry. A callbackUrl sent
    // in the body is carried in the outbox payload (Chunk 7-final), so the
    // verification link lands there instead of the default "/account".
    await resendVerificationEmail(parsed.data.email, parsed.data.callbackUrl ?? null);
    return jsonOk({ message: "If an eligible account exists, a verification email has been sent." });
  } catch (error) {
    console.error("[auth] verification email resend failed", error instanceof Error ? error.name : "UnknownError");
    // Stage 3 audit, L-1: this handler only ENQUEUES a verification
    // email in the outbox — it never sends one — so "unable to send a
    // verification email" misdescribed an enqueue/DB failure. Say what
    // failed. (Register's identical wording was already corrected in
    // the perf work; this is the same fix for resend.)
    return jsonError("Something went wrong while processing your request. Please try again later.", 500);
  }
}
