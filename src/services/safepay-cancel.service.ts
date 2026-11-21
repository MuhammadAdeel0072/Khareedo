import "server-only";
import type { PrismaClient } from "../../generated/postgres-client";
import type { SafepayConfig } from "@/lib/safepay/config";
import { verifyReturnStateForOwner } from "@/lib/safepay/redirect";
import {
  parseSafepayReturnContext,
  type SafepayReturnQuery,
} from "@/lib/safepay/return-input";
import {
  bindCheckoutOwner,
  type TrustedCheckoutOwner,
} from "./safepay-attempt.store";
import { createSafepayReservationService } from "./safepay-reservations.service";
import { enqueueOrderCancelledEmail } from "@/services/order-notification.service";

// Safepay cancel return (Phase 3, chunk 3-final — H-2).
//
// The cancel page used to be purely static: no server action, no API call,
// no reservation release. A customer who cancelled at the hosted checkout
// waited out the whole 15-minute hold, and if a tracker existed the order
// closed into review with the holds retained. This service is the missing
// wiring: it resolves the returning customer to their own managed order
// (signed local state first, provider tracker echo as fallback — the same
// two modes as the return page) and closes the reservation through the
// existing owner-bound reservation service. Local release only: no provider
// reversal is called, because none is confirmed (D6 pending) — and none is
// needed, because nothing was captured on a cancelled checkout.
//
// The close is idempotent by construction: closeManagedPendingOrder returns
// ALREADY_CLOSED for a second visit, so a refresh or double render can
// never double-release. The page renders truthful copy per outcome —
// RELEASED means no money moved, REVIEW_REQUIRED means a tracker existed
// and the payment may have been captured, so the holds stay for review.

export type SafepayCancelOutcome =
  | { kind: "released"; reference: string }
  | { kind: "review_required"; reference: string }
  | { kind: "already_closed"; reference: string }
  | { kind: "close_failed"; reference: string | null }
  | { kind: "invalid" };

type CancelDatabase = Pick<PrismaClient, "$transaction" | "payment">;

export async function resolveSafepayCancel(input: {
  config: SafepayConfig;
  database: CancelDatabase;
  query: SafepayReturnQuery;
  cookieState?: string;
  owner: TrustedCheckoutOwner;
  now?: number;
}): Promise<SafepayCancelOutcome> {
  const context = parseSafepayReturnContext(input.query, input.cookieState);
  if (context.kind === "empty") return { kind: "invalid" };

  let ownerBinding: ReturnType<typeof bindCheckoutOwner>;
  try {
    ownerBinding = bindCheckoutOwner(input.owner);
  } catch {
    return { kind: "invalid" };
  }

  // The signed state identifies the attempt; a failed HMAC/expiry check can
  // never widen the lookup — fall back to the tracker echo only when the
  // provider actually supplied one (same rule as the return page).
  const state = context.kind === "full" || context.kind === "state-only" ? context.state : null;
  const tracker = context.kind === "full" || context.kind === "tracker-only" ? context.trackerToken : null;
  const claims = state ? verifyReturnStateForOwner(input.config, state, ownerBinding.hash, input.now) : null;
  if (state && !claims && !tracker) return { kind: "invalid" };

  const payment = await input.database.payment.findFirst({
    where: {
      ...(claims ? { id: claims.paymentId, orderId: claims.orderId } : {}),
      provider: "SAFEPAY",
      providerEnvironment: input.config.environment,
      merchantAccountRef: input.config.merchantAccountRef,
      ...(tracker ? { trackerToken: tracker } : {}),
      order: {
        is: {
          userId: ownerBinding.userId,
          isGuest: false,
          checkoutOwnerKind: ownerBinding.kind,
          checkoutOwnerHash: ownerBinding.hash,
          paymentFlowVersion: 1,
          paymentMethod: "ONLINE",
        },
      },
    },
    select: { id: true, order: { select: { id: true, reference: true } } },
  });
  // A claimed payment id must match the row the lookup found: the state
  // alone never grants access to a different attempt.
  if (!payment || (claims && payment.id !== claims.paymentId)) return { kind: "invalid" };

  const reference = payment.order.reference;
  const reservations = createSafepayReservationService(input.database, () => new Date());
  const closed = await reservations.cancel(payment.order.id, input.owner);
  if (closed.ok && closed.outcome === "RELEASED") {
    // Order cancellation email (Chunk 7-final — D14): the customer just
    // cancelled at the hosted checkout and the reservation was released.
    // Best-effort; never throws.
    await enqueueOrderCancelledEmail({ orderId: payment.order.id });
    return { kind: "released", reference };
  }
  if (closed.ok && closed.outcome === "REVIEW_REQUIRED") {
    // Same email: the order was cancelled, even though the holds stay for
    // review because a tracker existed. ALREADY_CLOSED does not notify —
    // the email went out with the original close.
    await enqueueOrderCancelledEmail({ orderId: payment.order.id });
    return { kind: "review_required", reference };
  }
  if (closed.ok && closed.outcome === "ALREADY_CLOSED") return { kind: "already_closed", reference };
  return { kind: "close_failed", reference };
}
