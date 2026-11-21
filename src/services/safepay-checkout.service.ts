import "server-only";
import type { SafepayConfig } from "@/lib/safepay/config";
import { checkoutRequestSchema, type Tracker } from "@/lib/safepay/contracts";
import type { SafepayProvider } from "@/lib/safepay/provider";
import { prepareHostedRedirect, signReturnState, type HostedCheckoutRedirect } from "@/lib/safepay/redirect";
import { bindCheckoutOwner, type ClaimedAttempt, type OwnerBinding, type TrustedCheckoutOwner, type SafepayAttemptStore } from "./safepay-attempt.store";

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
    // A bound-but-never-issued tracker for the SAME request is resumed
    // instead of creating a second tracker (H-3): Safepay documents no
    // provider idempotency key for tracker creation, so the local claim +
    // the persisted trackerToken are the only dedup, and reuse is the only
    // safe recovery. Any other block (CREATING, CREATION_UNCERTAIN,
    // ALREADY_ISSUED, REQUEST_CONFLICT) is returned unchanged — in
    // particular a creation whose outcome is unknown is never retried.
    let claim: ClaimedAttempt;
    let tracker: Tracker | null = null;
    let resumeFrom: "TRACKER_CREATED" | "AUTHENTICATING" | null = null;
    if (claimed.kind === "claimed") {
      claim = claimed.claim;
    } else if (claimed.kind === "blocked" && claimed.code === "RESUME_BLOCKED") {
      const resumed = await deps.store.resume(input.data, owner, deps.config, now());
      if (resumed.kind !== "resumed") return { kind: "blocked", code: resumed.code };
      claim = resumed.claim;
      tracker = resumed.tracker;
      resumeFrom = resumed.from;
    } else {
      return claimed;
    }
    try {
      if (!tracker) {
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
        tracker = created.tracker;
        resumeFrom = "TRACKER_CREATED";
      }
      // A resumed AUTHENTICATING attempt already attached its metadata, so
      // it continues straight to authentication. A fresh or resumed
      // TRACKER_CREATED attempt (re)attaches metadata first.
      if (resumeFrom === "TRACKER_CREATED") {
        const metadata = await deps.provider.attachTrackerMetadata({
          trackerToken: tracker.token, orderId: claim.orderId,
        });
        if (metadata.kind !== "updated") {
          await deps.store.review(claim, "TRACKER_METADATA_UNCERTAIN", tracker, metadata.httpStatus, {
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
      }
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
        trackerToken: tracker.token, authentication: auth.token, state,
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
