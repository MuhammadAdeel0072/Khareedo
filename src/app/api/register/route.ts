// Customer registration (FR-02). Rate-limited (NFR-16).
import { registerUser } from "@/services/users.service";
import { registerSchema } from "@/lib/validation";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { jsonError, jsonOk, parseBody } from "@/lib/api";

export async function POST(request: Request) {
  try {
    const ip = clientIp(request.headers);
    const limit = rateLimit(`register:${ip}`, 5, 10 * 60 * 1000);
    if (!limit.ok) {
      return jsonError(`Too many attempts. Please try again in ${limit.retryAfterSec}s.`, 429);
    }

    // Stage 3 audit, L-5: parseBody caps the body at 1 MiB (the old
    // request.json() had no cap) and validates against the same schema
    // registerUser uses, so invalid input still maps to 422 with field
    // errors and an unparseable body still maps to 400.
    const parsed = await parseBody(request, registerSchema);
    if (parsed.error) return parsed.error;
    const body = parsed.data;

    // Registration only enqueues a verification email in the outbox (Phase 3
    // Chunk 7, M-24), so it succeeds whether or not SMTP is currently
    // reachable. There is no email-configuration failure to report here:
    // a failed delivery shows up as a FAILED outbox row for an admin to
    // retry. A callbackUrl sent in the body is carried in the outbox
    // payload (Chunk 7-final), so the verification link lands there instead
    // of the default "/account" destination — see email-outbox.service.ts.)
    const result = await registerUser(body);
    if (!result.ok) return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });

    return jsonOk({ verificationPending: true });
  } catch (error) {
    console.error("[auth] registration request failed", error instanceof Error ? error.name : "UnknownError");
    // The failure is in registerUser (validation or outbox enqueue) —
    // registration only ENQUEUES a verification email, it never sends
    // one synchronously, so "unable to send a verification email"
    // misdescribed the failure. Say what actually failed.
    return jsonError("Something went wrong while creating your account. Please try again.", 500);
  }
}
