// Customer registration (FR-02). Rate-limited (NFR-16).
import { registerUser } from "@/services/users.service";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { jsonError, jsonOk } from "@/lib/api";
import { EmailDeliveryNotConfiguredError } from "@/services/email.service";
import { safeCallbackUrl } from "@/lib/auth-client";

export async function POST(request: Request) {
  try {
    const ip = clientIp(request.headers);
    const limit = rateLimit(`register:${ip}`, 5, 10 * 60 * 1000);
    if (!limit.ok) {
      return jsonError(`Too many attempts. Please try again in ${limit.retryAfterSec}s.`, 429);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid request body", 400);
    }

    const callbackUrl =
      typeof body === "object" &&
      body !== null &&
      "callbackUrl" in body &&
      typeof body.callbackUrl === "string"
        ? safeCallbackUrl(body.callbackUrl)
        : "/account";
    const result = await registerUser(body, callbackUrl);
    if (!result.ok) return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });

    return jsonOk({ verificationPending: true });
  } catch (error) {
    if (error instanceof EmailDeliveryNotConfiguredError) {
      return jsonError("Email verification is not configured. Please contact the store administrator.", 503);
    }
    console.error("[auth] registration request failed", error instanceof Error ? error.name : "UnknownError");
    return jsonError("Unable to send a verification email. Please try again.", 500);
  }
}
