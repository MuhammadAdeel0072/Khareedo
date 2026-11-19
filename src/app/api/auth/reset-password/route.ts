// Password reset redemption (PR-09). Validates a single-use, expiring
// token and sets a new password. The response does not distinguish between
// an invalid, expired, or already-used token, and never reveals whether an
// account exists. Rate-limited per IP to slow token guessing.
import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { passwordSchema } from "@/lib/validation";
import { resetPasswordWithToken } from "@/services/password-reset.service";

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Reset link is missing.").max(256),
  password: passwordSchema,
});

export async function POST(request: Request) {
  const parsed = await parseBody(request, resetPasswordSchema);
  if (parsed.error) return parsed.error;

  const ip = clientIp(request.headers);
  const limit = rateLimit(`password-reset-redeem-ip:${ip}`, 10, 15 * 60 * 1000);
  if (!limit.ok) {
    return jsonError("Too many requests. Please try again later.", 429, {
      retryAfterSec: limit.retryAfterSec,
    });
  }

  try {
    const user = await resetPasswordWithToken(parsed.data.token, parsed.data.password);
    if (!user) {
      // Same message for invalid, expired, or already-used tokens.
      return jsonError("This password reset link is invalid or has expired. Please request a new one.", 400);
    }
    return jsonOk({ message: "Your password has been reset. You can now sign in with your new password." });
  } catch (error) {
    console.error("[auth] password reset failed", error instanceof Error ? error.name : "UnknownError");
    return jsonError("Unable to reset your password. Please try again later.", 500);
  }
}
