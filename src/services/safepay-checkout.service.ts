import "server-only";
import type { SafepayConfig } from "@/lib/safepay/config";
import { checkoutRequestSchema } from "@/lib/safepay/contracts";
import type { SafepayProvider } from "@/lib/safepay/provider";
import { prepareHostedRedirect, signReturnState, type HostedCheckoutRedirect } from "@/lib/safepay/redirect";
import { bindCheckoutOwner, type OwnerBinding, type TrustedCheckoutOwner, type SafepayAttemptStore } from "./safepay-attempt.store";

export type SafepaySessionResult =
  { kind: "ready"; redirect: HostedCheckoutRedirect; state: string } |
  { kind: "blocked" | "uncertain"; code: string };

// Only consumes an authenticated user's server-priced order with HELD reservations and a READY attempt.
export function createSafepayCheckoutService(deps: {
  config: SafepayConfig; provider: SafepayProvider; store: SafepayAttemptStore; now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return async (rawRequest: unknown, trustedOwner: TrustedCheckoutOwner): Promise<SafepaySessionResult> => {
    const input = checkoutRequestSchema.safeParse(rawRequest);
    if (!input.success) return { kind: "blocked", code: "INVALID_REQUEST" };
    let owner: OwnerBinding;
    try { owner = bindCheckoutOwner(trustedOwner); } catch { return { kind: "blocked", code: "INVALID_OWNER" }; }
    const claimed = await deps.store.claim(input.data, owner, deps.config, now());
    if (claimed.kind !== "claimed") return claimed;
    let claim = claimed.claim;
    try {
      const created = await deps.provider.createTracker({
        orderId: claim.orderId, paymentId: claim.paymentId, amountMinor: claim.amountMinor,
      });
      if (created.kind !== "created") {
        await deps.store.review(claim, created.code, created.tracker, created.httpStatus, {
          providerErrorCode: created.providerErrorCode,
          providerMessage: created.providerMessage,
        });
        return { kind: created.kind === "uncertain" ? "uncertain" : "blocked", code: created.code };
      }
      const bound = await deps.store.bindTracker(claim, created.tracker, deps.config, now());
      if (!bound) {
        await deps.store.review(claim, "TRACKER_BIND_FAILED", created.tracker);
        return { kind: "uncertain", code: "PERSISTENCE_UNCERTAIN" };
      }
      claim = bound;
      const metadata = await deps.provider.attachTrackerMetadata({
        trackerToken: created.tracker.token, orderId: claim.orderId,
      });
      if (metadata.kind !== "updated") {
        await deps.store.review(claim, "TRACKER_METADATA_UNCERTAIN", created.tracker, metadata.httpStatus, {
          providerErrorCode: metadata.providerErrorCode,
          providerMessage: metadata.providerMessage,
        });
        return { kind: "uncertain", code: "TRACKER_METADATA_UNCERTAIN" };
      }
      const authenticating = await deps.store.advance(claim, deps.config, "TRACKER_CREATED", "AUTHENTICATING", now());
      if (!authenticating) {
        await deps.store.review(claim, "CHECKOUT_NOT_ELIGIBLE");
        return { kind: "blocked", code: "CHECKOUT_NOT_ELIGIBLE" };
      }
      claim = authenticating;
      const auth = await deps.provider.authenticate();
      if (auth.kind !== "authenticated") {
        await deps.store.review(claim, auth.code, undefined, auth.httpStatus, {
          providerErrorCode: auth.providerErrorCode,
          providerMessage: auth.providerMessage,
        });
        return { kind: "blocked", code: "AUTHENTICATION_UNAVAILABLE" };
      }
      const current = now();
      const state = signReturnState(deps.config, {
        orderId: claim.orderId, paymentId: claim.paymentId, ownerHash: claim.owner.hash,
        expiresAt: Math.min(claim.deadlineMs, current.getTime() + 15 * 60 * 1000),
      }, current.getTime());
      const redirect = prepareHostedRedirect(deps.config, {
        trackerToken: created.tracker.token, authentication: auth.token, state,
      });
      if (!await deps.store.advance(claim, deps.config, "AUTHENTICATING", "CHECKOUT_ISSUED", now())) {
        await deps.store.review(claim, "CHECKOUT_NOT_ELIGIBLE");
        return { kind: "blocked", code: "CHECKOUT_NOT_ELIGIBLE" };
      }
      // The signed state is also returned so the route can carry it to the return page
      // in a first-party cookie: provider query appending must never be load-bearing.
      return { kind: "ready", redirect, state };
    } catch {
      await deps.store.review(claim, "UNEXPECTED_SESSION_ERROR");
      return { kind: "uncertain", code: "SESSION_UNCERTAIN" };
    }
  };
}
