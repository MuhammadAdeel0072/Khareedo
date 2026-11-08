import "server-only";
import type { SafepayConfig } from "@/lib/safepay/config";
import { verifyReturnStateForOwner } from "@/lib/safepay/redirect";
import {
  bindCheckoutOwner,
  type TrustedCheckoutOwner,
} from "./safepay-attempt.store";

export type SafepayReturnSnapshot = Readonly<{
  paymentId: string;
  paymentStatus: string;
  attemptState: string | null;
  reconcileStatus: string | null;
  paidVerifiedAt: Date | null;
  orderPaymentStatus: string;
  acceptedPaymentId: string | null;
  reference: string;
}>;

export type SafepayReturnResult =
  | { kind: "invalid" }
  | { kind: "success" | "pending" | "failure"; reference: string };

export type SafepayReturnLookupInput =
  | {
      // State-verified path: claims identify the attempt; trackerToken cross-checks the
      // provider echo when one arrived. Null token means the DB record supplies it.
      mode: "claimed";
      orderId: string;
      paymentId: string;
      trackerToken: string | null;
      owner: ReturnType<typeof bindCheckoutOwner>;
    }
  | {
      // Tracker-only path: the provider echo plus the session-derived owner binding
      // identify the attempt. Attribution strength is unchanged — the DB lookup still
      // requires order.userId == session user and the managed hosted-checkout shape;
      // the signed local state only added a freshness bound to this read-only page.
      mode: "tracker";
      trackerToken: string;
      owner: ReturnType<typeof bindCheckoutOwner>;
    };

export function createSafepayReturnService(
  config: SafepayConfig,
  lookup: (input: SafepayReturnLookupInput) => Promise<SafepayReturnSnapshot | null>,
) {
  return async (input: {
    state?: string;
    tracker?: string;
    owner: TrustedCheckoutOwner;
    now?: number;
  }): Promise<SafepayReturnResult> => {
    const hasState = typeof input.state === "string" && input.state.length > 0;
    const tracker =
      typeof input.tracker === "string" && input.tracker.length >= 1 &&
      input.tracker.length <= 2048 && !/[^\x21-\x7e]/.test(input.tracker)
        ? input.tracker
        : null;
    if (!hasState && !tracker) {
      console.warn("[Safepay return] RETURN_INPUT_REJECTED");
      return { kind: "invalid" };
    }

    let owner: ReturnType<typeof bindCheckoutOwner>;
    try {
      owner = bindCheckoutOwner(input.owner);
    } catch {
      console.warn("[Safepay return] RETURN_OWNER_REJECTED");
      return { kind: "invalid" };
    }

    let claims: ReturnType<typeof verifyReturnStateForOwner> = null;
    if (hasState && input.state) {
      claims = verifyReturnStateForOwner(config, input.state, owner.hash, input.now);
      if (!claims) {
        // A state that fails HMAC/expiry checks can never widen the lookup: fall back to
        // the tracker echo only when the provider actually supplied one.
        if (!tracker) {
          console.warn("[Safepay return] RETURN_STATE_REJECTED");
          return { kind: "invalid" };
        }
        console.warn("[Safepay return] RETURN_STATE_REJECTED_TRACKER_FALLBACK");
      } else {
        console.info("[Safepay return] RETURN_STATE_VERIFIED");
      }
    }

    const snapshot = claims
      ? await lookup({
          mode: "claimed", orderId: claims.orderId, paymentId: claims.paymentId,
          trackerToken: tracker, owner,
        })
      : await lookup({ mode: "tracker", trackerToken: tracker!, owner });

    if (!snapshot || (claims && snapshot.paymentId !== claims.paymentId)) {
      console.warn("[Safepay return] PAYMENT_LOOKUP_MISS");
      return { kind: "invalid" };
    }

    console.info("[Safepay return] PAYMENT_LOOKUP_MATCHED");

    if (
      snapshot.paymentStatus === "PAID" &&
      snapshot.orderPaymentStatus === "PAID" &&
      snapshot.acceptedPaymentId === snapshot.paymentId &&
      snapshot.paidVerifiedAt !== null &&
      snapshot.reconcileStatus === "VERIFIED" &&
      snapshot.attemptState === "SETTLED"
    ) {
      return { kind: "success", reference: snapshot.reference };
    }

    if (
      snapshot.paymentStatus === "FAILED" &&
      snapshot.orderPaymentStatus === "FAILED" &&
      snapshot.reconcileStatus === "FAILED" &&
      snapshot.attemptState === "FAILED"
    ) {
      return { kind: "failure", reference: snapshot.reference };
    }

    console.info("[Safepay return] RETURN_PENDING");
    return { kind: "pending", reference: snapshot.reference };
  };
}
