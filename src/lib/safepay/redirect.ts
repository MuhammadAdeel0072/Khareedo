import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SafepayConfig } from "./config";
import { localId } from "./contracts";
import type { AuthenticationToken } from "./provider";

const DOMAIN = "KHAREEDO_SAFEPAY_RETURN_V1.";
const LOCAL_MAX_AGE_MS = 15 * 60 * 1000; // Local authorization bound; not provider token expiry.
const claimsSchema = z.object({
  v: z.literal(1), orderId: localId, paymentId: localId,
  ownerHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().refine(Number.isSafeInteger),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type ReturnClaims = z.infer<typeof claimsSchema>;

export function signReturnState(
  config: SafepayConfig,
  input: Omit<ReturnClaims, "v" | "nonce">,
  now = Date.now(),
): string {
  if (input.expiresAt <= now || input.expiresAt > now + LOCAL_MAX_AGE_MS) throw new Error("Invalid local checkout deadline.");
  const claims = claimsSchema.parse({ ...input, v: 1, nonce: randomBytes(32).toString("base64url") });
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return payload + "." + config.signReturnState(DOMAIN + payload).toString("base64url");
}

// Own application HMAC, unrelated to the unresolved Safepay webhook signature contract.
// The caller must ALSO derive the owner from the session/guest cookie. State alone grants no access.
export function verifyReturnState(config: SafepayConfig, value: string, expected: {
  orderId: string; paymentId: string; ownerHash: string;
}, now = Date.now()): ReturnClaims | null {
  const claims = verifyReturnStateForOwner(config, value, expected.ownerHash, now);
  return claims && claims.orderId === expected.orderId && claims.paymentId === expected.paymentId
    ? claims
    : null;
}

export function verifyReturnStateForOwner(
  config: SafepayConfig,
  value: string,
  ownerHash: string,
  now = Date.now(),
): ReturnClaims | null {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const [payload, signature] = value.split(".");
    const received = Buffer.from(signature, "base64url");
    if (received.toString("base64url") !== signature) return null;
    const actual = config.signReturnState(DOMAIN + payload);
    if (received.length !== actual.length || !timingSafeEqual(received, actual)) return null;
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (claims.expiresAt <= now || claims.expiresAt > now + LOCAL_MAX_AGE_MS || claims.ownerHash !== ownerHash) return null;
    return claims;
  } catch { return null; }
}

export class HostedCheckoutRedirect {
  #url: string;
  constructor(url: URL, config: SafepayConfig) {
    const expected = new URL(config.checkoutUrl);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) {
      throw new Error("Invalid hosted checkout destination.");
    }
    this.#url = url.href;
  }
  location(): string { return this.#url; }
  toJSON() { return "[REDACTED hosted checkout redirect]"; }
  response(): Response {
    return new Response(null, { status: 303, headers: {
      Location: this.#url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    } });
  }
}

export function prepareHostedRedirect(config: SafepayConfig, input: {
  trackerToken: string; authentication: AuthenticationToken; state: string;
}): HostedCheckoutRedirect {
  if (!input.trackerToken || input.trackerToken.length > 2048 || /[\u0000-\u0020\u007f]/.test(input.trackerToken) ||
      !input.state || input.state.length > 2048) throw new Error("Invalid checkout redirect input.");
  const success = new URL("/checkout/safepay/return", config.siteOrigin);
  const cancel = new URL("/checkout/safepay/cancel", config.siteOrigin);
  success.searchParams.set("state", input.state); cancel.searchParams.set("state", input.state);
  const checkout = new URL(config.checkoutUrl);
  checkout.search = new URLSearchParams({
    environment: config.environment, tracker: input.trackerToken, tbt: input.authentication.revealForCheckout(),
    source: "hosted", redirect_url: success.href, cancel_url: cancel.href,
  }).toString();
  return new HostedCheckoutRedirect(checkout, config);
}
