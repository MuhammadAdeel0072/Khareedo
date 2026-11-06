import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth-guard";
import { resolveCart } from "@/services/cart.service";
import { getSettings } from "@/services/settings.service";
import { createSafepayCheckoutService } from "@/services/safepay-checkout.service";
import { createSafepayPendingOrderService } from "@/services/safepay-pending-order.service";
import { createPrismaSafepayStore, type PaymentDatabase } from "@/services/safepay-attempt.store";
import { loadSafepayConfig, SafepayConfigurationError } from "@/lib/safepay/config";
import { createSafepayProvider } from "@/lib/safepay/provider";
import { SAFEPAY_SANDBOX_SESSION_ENABLED } from "@/lib/safepay/readiness";
import { placeOrderSchema } from "@/lib/validation";
import { parseBody, jsonError } from "@/lib/api";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = placeOrderSchema.extend({ paymentMethod: z.literal("ONLINE") }).strict();
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function blocked(code: string, status = 422) {
  return Response.json({ ok: false, code, error: "Could not start secure checkout. Please try again." }, { status, headers: noStore });
}

export async function POST(request: Request) {
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
    config = loadSafepayConfig();
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
    const status = pending.code === "BUSY" ? 409 :
      pending.code === "PERSISTENCE_UNAVAILABLE" ? 503 : 422;
    return blocked(pending.code, status);
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
    const status = session.kind === "uncertain" || session.code === "AUTHENTICATION_UNAVAILABLE" ? 502 :
      ["BUSY", "ALREADY_ISSUED", "REQUEST_CONFLICT", "CREATION_UNCERTAIN", "RESUME_BLOCKED"].includes(session.code) ? 409 : 422;
    return blocked(session.code, status);
  }

  return Response.json({
    ok: true,
    reference: pending.reference,
    redirectUrl: session.redirect.location(),
  }, { headers: noStore });
}
