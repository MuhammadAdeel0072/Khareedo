import "server-only";
import type { SafepayConfig } from "@/lib/safepay/config";
import { verifyReturnStateForOwner } from "@/lib/safepay/redirect";
import { bindCheckoutOwner, type TrustedCheckoutOwner } from "./safepay-attempt.store";

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

export function createSafepayReturnService(
  config: SafepayConfig,
  lookup: (input: {
    orderId: string;
    paymentId: string;
    trackerToken: string;
    owner: ReturnType<typeof bindCheckoutOwner>;
  }) => Promise<SafepayReturnSnapshot | null>,
) {
  return async (input: {
    state: string;
    tracker: string;
    owner: TrustedCheckoutOwner;
    now?: number;
  }): Promise<SafepayReturnResult> => {
    if (typeof input.state !== "string" || typeof input.tracker !== "string" ||
        input.tracker.length < 1 || input.tracker.length > 2048 ||
        /[^\x21-\x7e]/.test(input.tracker)) return { kind: "invalid" };

    let owner: ReturnType<typeof bindCheckoutOwner>;
    try {
      owner = bindCheckoutOwner(input.owner);
    } catch {
      return { kind: "invalid" };
    }

    const claims = verifyReturnStateForOwner(config, input.state, owner.hash, input.now);
    if (!claims) return { kind: "invalid" };

    const snapshot = await lookup({
      orderId: claims.orderId,
      paymentId: claims.paymentId,
      trackerToken: input.tracker,
      owner,
    });
    if (!snapshot || snapshot.paymentId !== claims.paymentId) return { kind: "invalid" };

    if (snapshot.paymentStatus === "PAID" && snapshot.orderPaymentStatus === "PAID" &&
        snapshot.acceptedPaymentId === snapshot.paymentId && snapshot.paidVerifiedAt !== null &&
        snapshot.reconcileStatus === "VERIFIED" && snapshot.attemptState === "SETTLED") {
      return { kind: "success", reference: snapshot.reference };
    }

    if (snapshot.paymentStatus === "FAILED" && snapshot.orderPaymentStatus === "FAILED" &&
        snapshot.reconcileStatus === "FAILED" && snapshot.attemptState === "FAILED") {
      return { kind: "failure", reference: snapshot.reference };
    }

    return { kind: "pending", reference: snapshot.reference };
  };
}
