import Link from "next/link";
import { getSessionUser } from "@/lib/auth-guard";
import { loadSafepayConfig, SafepayConfigurationError } from "@/lib/safepay/config";
import { db } from "@/lib/db";
import { createSafepayReturnService, type SafepayReturnResult } from "@/services/safepay-return.service";

export const dynamic = "force-dynamic";

type SearchParams = { state?: string | string[]; tracker?: string | string[] };

export default async function SafepayReturnPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  let result: SafepayReturnResult = { kind: "invalid" };

  if (user && typeof params.state === "string" && typeof params.tracker === "string") {
    let config;
    try {
      config = loadSafepayConfig();
    } catch (error) {
      if (!(error instanceof SafepayConfigurationError)) throw error;
    }

    if (config) {
      const readReturn = createSafepayReturnService(config, async ({ orderId, paymentId, trackerToken, owner }) => {
        const payment = await db.payment.findFirst({
          where: {
            id: paymentId,
            orderId,
            provider: "SAFEPAY",
            providerEnvironment: config.environment,
            merchantAccountRef: config.merchantAccountRef,
            trackerToken,
            order: {
              is: {
                userId: owner.userId,
                isGuest: false,
                checkoutOwnerKind: owner.kind,
                checkoutOwnerHash: owner.hash,
                paymentFlowVersion: 1,
                paymentMethod: "ONLINE",
              },
            },
          },
          select: {
            id: true,
            status: true,
            attemptState: true,
            reconcileStatus: true,
            paidVerifiedAt: true,
            order: { select: { reference: true, paymentStatus: true, acceptedPaymentId: true } },
          },
        });
        if (!payment) return null;
        return {
          paymentId: payment.id,
          paymentStatus: payment.status,
          attemptState: payment.attemptState,
          reconcileStatus: payment.reconcileStatus,
          paidVerifiedAt: payment.paidVerifiedAt,
          orderPaymentStatus: payment.order.paymentStatus,
          acceptedPaymentId: payment.order.acceptedPaymentId,
          reference: payment.order.reference,
        };
      });

      result = await readReturn({
        state: params.state,
        tracker: params.tracker,
        owner: { kind: "USER", userId: user.id },
      });
    }
  }

  const content = {
    success: {
      title: "Payment verified",
      message: `Payment for order ${result.kind === "success" ? result.reference : ""} has been confirmed.`,
      tone: "border-green-200 bg-green-50 text-green-900",
    },
    pending: {
      title: "Payment verification pending",
      message: `Order ${result.kind === "pending" ? result.reference : ""} is awaiting secure server-side payment verification. This return page is not proof of payment. Please do not start another payment attempt.`,
      tone: "border-amber-200 bg-amber-50 text-amber-950",
    },
    failure: {
      title: "Payment not completed",
      message: `The payment for order ${result.kind === "failure" ? result.reference : ""} is recorded as failed. The order has not been confirmed.`,
      tone: "border-red-200 bg-red-50 text-red-900",
    },
    invalid: {
      title: "Return could not be verified",
      message: "We could not verify this Safepay return. Sign in with the checkout account and check your order status.",
      tone: "border-border bg-muted text-foreground",
    },
  }[result.kind];

  return (
    <main className="container-khd max-w-2xl py-16">
      <section className={`rounded-xl border p-6 text-center sm:p-8 ${content.tone}`} aria-live="polite">
        <h1 className="text-2xl font-bold">{content.title}</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6">{content.message}</p>
        <div className="mt-6 flex justify-center gap-3">
          <Link className="rounded-md border px-4 py-2 text-sm font-medium" href="/account/orders">
            View my orders
          </Link>
          <Link className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href="/">
            Continue shopping
          </Link>
        </div>
      </section>
    </main>
  );
}
