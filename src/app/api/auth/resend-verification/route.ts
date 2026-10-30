import { createHash } from "node:crypto";
import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { emailSchema } from "@/lib/validation";
import { EmailDeliveryNotConfiguredError, isEmailDeliveryConfigured } from "@/services/email.service";
import { resendVerificationEmail } from "@/services/email-verification.service";

const resendSchema = z.object({ email: emailSchema });

export async function POST(request: Request) {
  const parsed = await parseBody(request, resendSchema);
  if (parsed.error) return parsed.error;

  const ip = clientIp(request.headers);
  const emailKey = createHash("sha256").update(parsed.data.email).digest("hex");
  const ipLimit = rateLimit(`verify-resend-ip:${ip}`, 10, 15 * 60 * 1000);
  const emailLimit = rateLimit(`verify-resend-email:${emailKey}`, 3, 60 * 60 * 1000);
  if (!ipLimit.ok || !emailLimit.ok) {
    return jsonError("Too many requests. Please try again later.", 429);
  }

  try {
    if (!isEmailDeliveryConfigured()) {
      throw new EmailDeliveryNotConfiguredError();
    }
    await resendVerificationEmail(parsed.data.email);
    return jsonOk({ message: "If an eligible account exists, a verification email has been sent." });
  } catch (error) {
    if (error instanceof EmailDeliveryNotConfiguredError) {
      return jsonError("Email verification is not configured. Please contact the store administrator.", 503);
    }
    console.error("[auth] verification email resend failed", error instanceof Error ? error.name : "UnknownError");
    return jsonError("Unable to send a verification email. Please try again later.", 500);
  }
}
