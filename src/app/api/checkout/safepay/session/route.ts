import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth-guard";
import { resolveCart } from "@/services/cart.service";
import { getSettings } from "@/services/settings.service";
import { createSafepayCheckoutService } from "@/services/safepay-checkout.service";
import { createSafepayPendingOrderService } from "@/services/safepay-pending-order.service";
import { createPrismaSafepayStore, type PaymentDatabase } from "@/services/safepay-attempt.store";
import { loadSafepayConfig, SafepayConfigurationError } from "@/lib/safepay/config";
import { requestOrigin } from "@/lib/request-origin";
import { SAFEPAY_RETURN_STATE_COOKIE } from "@/lib/safepay/return-input";
import { createSafepayProvider } from "@/lib/safepay/provider";
import { SAFEPAY_SANDBOX_SESSION_ENABLED } from "@/lib/safepay/readiness";
import { placeOrderSchema } from "@/lib/validation";
import { parseBody, jsonError, handleRoute } from "@/lib/api";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = placeOrderSchema.extend({ paymentMethod: z.literal("ONLINE") }).strict();
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function blocked(code: string, status = 422, headers?: Record<string, string>) {
  return Response.json({ ok: false, code, error: "Could not start secure checkout. Please try again." }, { status, headers: { ...noStore, ...headers } });
}

export async function POST(request: Request) {
  // Stage 3 audit, M-7: wrapped in handleRoute so an unexpected throw
  // (DB down in resolveCart/pendingOrder/checkout) becomes a JSON 500
  // instead of Next.js's default HTML 500 page, which the checkout form
  // misreported as a network problem. Auth/rate-limit/validation
  // responses are unchanged; only the uncaught-throw path changes.
  return handleRoute(async () => {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ ok: false, code: "AUTHENTICATION_REQUIRED", error: "Please sign in to continue." },
      { status: 401, headers: noStore });
  }

  const limit = rateLimit(`safepay-checkout:${clientIp(request.headers)}`, 10, 5 * 60 * 1000);
  if (!limit.ok) {
    return Response.json({ ok: false, code: "RATE_LIMITED", error: `Too many attempts. Please try again in ${limit.retryAfterSec}s.` },
      { status: 429, headers: noStore });
  }

  const parsed = await parseBody(request, requestSchema);
  if (parsed.error) return parsed.error;

  let config;
  try {
    // Origin follows the visitor's host (proxy-aware) so hosted-checkout return
    // URLs land back on the same origin the checkout started from.
    config = loadSafepayConfig(process.env, requestOrigin(request.headers) ?? undefined);
  } catch (error) {
    if (error instanceof SafepayConfigurationError) return blocked("SAFEPAY_CONFIGURATION_UNAVAILABLE", 503);
    throw error;
  }
  if (!SAFEPAY_SANDBOX_SESSION_ENABLED || config.environment !== "sandbox") {
    return Response.json({ ok: false, code: "SAFEPAY_SANDBOX_ONLY", error: "Safepay checkout is available only in the sandbox." },
      { status: 503, headers: noStore });
  }

  const cart = await resolveCart(false);
  if (!cart) return blocked("CART_UNAVAILABLE", 409);
  if (cart.isGuest) return blocked("CART_OWNER_MISMATCH", 403);
  const owner = { kind: "USER" as const, userId: user.id };

  const database = db as unknown as PaymentDatabase;
  const pendingOrder = createSafepayPendingOrderService({
    database,
    getSettings,
    environment: "sandbox",
    merchantAccountRef: config.merchantAccountRef,
    reservationTtlMs: RESERVATION_TTL_MS,
  });
  const pending = await pendingOrder(parsed.data, {
    owner,
    cartId: cart.id,
  });
  if (pending.kind !== "ready") {
    // Stage 3 audit, M-7: BUSY is contention, not a client conflict —
    // 503 with Retry-After, consistent with POST /api/checkout/place
    // (which used to be the only place-order path returning 503 here).
    // PERSISTENCE_UNAVAILABLE stays 503; every other block stays 422.
    const status = pending.code === "BUSY" ? 503 :
      pending.code === "PERSISTENCE_UNAVAILABLE" ? 503 : 422;
    return blocked(pending.code, status, pending.code === "BUSY" ? { "Retry-After": "5" } : undefined);
  }

  const checkout = createSafepayCheckoutService({
    config,
    provider: createSafepayProvider(config),
    store: createPrismaSafepayStore(database),
  });
  const session = await checkout({
    orderId: pending.orderId,
    paymentId: pending.paymentId,
    requestKey: parsed.data.idempotencyKey,
  }, owner);
  if (session.kind !== "ready") {
    // BUSY here is the same contention signal as in the pending-order
    // step: 503 with Retry-After, not 409. ALREADY_ISSUED /
    // REQUEST_CONFLICT / CREATION_UNCERTAIN / RESUME_BLOCKED stay 409
    // (the request itself conflicts with an existing tracker).
    const status = session.kind === "uncertain" || session.code === "AUTHENTICATION_UNAVAILABLE" ? 502 :
      session.code === "BUSY" ? 503 :
      ["ALREADY_ISSUED", "REQUEST_CONFLICT", "CREATION_UNCERTAIN", "RESUME_BLOCKED"].includes(session.code) ? 409 : 422;
    return blocked(session.code, status, session.code === "BUSY" ? { "Retry-After": "5" } : undefined);
  }

  // The local signed return state travels in a first-party HttpOnly cookie so the
  // return page never depends on how Safepay merges query params into redirect_url.
  const stateCookie = [
    `${SAFEPAY_RETURN_STATE_COOKIE}=${session.state}`,
    "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=900",
    ...(config.siteOrigin.startsWith("https:") ? ["Secure"] : []),
  ].join("; ");

  return Response.json({
    ok: true,
    reference: pending.reference,
    redirectUrl: session.redirect.location(),
  }, { headers: { ...noStore, "Set-Cookie": stateCookie } });
  }, request);
}
