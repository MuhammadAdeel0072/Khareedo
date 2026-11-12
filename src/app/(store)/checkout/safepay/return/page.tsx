import Link from "next/link";
import { cookies, headers } from "next/headers";
import { getSessionUser } from "@/lib/auth-guard";
import {
  loadSafepayConfig,
  SafepayConfigurationError,
} from "@/lib/safepay/config";
import { createSafepayProvider } from "@/lib/safepay/provider";
import { parseSafepayReturnContext, SAFEPAY_RETURN_STATE_COOKIE } from "@/lib/safepay/return-input";
import { requestOrigin } from "@/lib/request-origin";
import { db } from "@/lib/db";
import {
  createSafepayReturnService,
  type SafepayReturnResult,
} from "@/services/safepay-return.service";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentVerificationService } from "@/services/payment-verification.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { loadPaymentPayloadVaultKeys } from "@/lib/payments/vault-env";

export const dynamic = "force-dynamic";

type SearchParams = { state?: string | string[]; tracker?: string | string[] };

export default async function SafepayReturnPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  const cookieStore = await cookies();
  const context = parseSafepayReturnContext(params, cookieStore.get(SAFEPAY_RETURN_STATE_COOKIE)?.value);

  // Diagnostics intentionally log sources and presence only — never param values.
  console.info("[Safepay return] REQUEST_CHECK", {
    hasUser: Boolean(user),
    contextKind: context.kind,
    trackerSource: "trackerSource" in context ? context.trackerSource : null,
    stateSource: "stateSource" in context ? context.stateSource : null,
  });

  let result: SafepayReturnResult = { kind: "invalid" };

  if (user && context.kind !== "empty") {
    let config;
    try {
      config = loadSafepayConfig(process.env, requestOrigin(await headers()) ?? undefined);
    } catch (error) {
      console.warn("[Safepay return] CONFIGURATION_UNAVAILABLE");
      if (!(error instanceof SafepayConfigurationError)) throw error;
    }

    if (config) {
      const readReturn = createSafepayReturnService(
        config,
        async input => {
          if (input.mode === "tracker") {
            // Provider echo identifies the attempt; the order binding comes from the
            // server session, never from browser-supplied identifiers.
            const payment = await db.payment.findFirst({
              where: {
                provider: "SAFEPAY",
                providerEnvironment: config.environment,
                merchantAccountRef: config.merchantAccountRef,
                trackerToken: input.trackerToken,
                order: {
                  is: {
                    userId: input.owner.userId,
                    isGuest: false,
                    checkoutOwnerKind: input.owner.kind,
                    checkoutOwnerHash: input.owner.hash,
                    paymentFlowVersion: 1,
                    paymentMethod: "ONLINE",
                  },
                },
              },
              select: {
                id: true, status: true, attemptState: true, reconcileStatus: true,
                paidVerifiedAt: true,
                order: { select: { reference: true, paymentStatus: true, acceptedPaymentId: true } },
              },
            });
            return payment ? snapshotFrom(payment) : null;
          }
          const payment = await db.payment.findFirst({
            where: {
              id: input.paymentId,
              orderId: input.orderId,
              provider: "SAFEPAY",
              providerEnvironment: config.environment,
              merchantAccountRef: config.merchantAccountRef,
              ...(input.trackerToken ? { trackerToken: input.trackerToken } : {}),
              order: {
                is: {
                  userId: input.owner.userId,
                  isGuest: false,
                  checkoutOwnerKind: input.owner.kind,
                  checkoutOwnerHash: input.owner.hash,
                  paymentFlowVersion: 1,
                  paymentMethod: "ONLINE",
                },
              },
            },
            select: {
              id: true, status: true, attemptState: true, reconcileStatus: true,
              paidVerifiedAt: true,
              order: { select: { reference: true, paymentStatus: true, acceptedPaymentId: true } },
            },
          });
          if (payment) {
            console.info("[Safepay return] DATABASE_LOOKUP", { matched: true });
            return snapshotFrom(payment);
          }
          console.info("[Safepay return] DATABASE_LOOKUP", { matched: false });
          return null;
        },
      );

      result = await readReturn({
        ...(context.kind === "state-only" || context.kind === "full" ? { state: context.state } : {}),
        ...(context.kind === "tracker-only" || context.kind === "full" ? { tracker: context.trackerToken } : {}),
        owner: { kind: "USER", userId: user.id },
      });

      // The return page is read-only evidence about a PENDING payment — by design it
      // never trusts the browser redirect. But a pending result used to dead-end here:
      // nothing ever initiated server-side verification, so a customer who paid
      // successfully at the hosted checkout stayed "pending" forever unless a webhook
      // arrived (impossible on origins Safepay cannot reach) or an administrator ran a
      // reconciliation sweep manually. While the customer is on this page we have the
      // strongest available signal that the hosted checkout just finished, so trigger
      // ONE targeted server-initiated verification for THIS owner's payment. The lookup
      // above already proved the payment belongs to the signed-in customer's own
      // managed order; the tracker token still comes exclusively from the database,
      // and settlement re-validates identity, amounts and state inside its own
      // transaction. A provider transport failure only schedules a retry — it can
      // never turn a pending payment into success or failure by itself.
      if (result.kind === "pending") {
        try {
          const vaultKeys = loadPaymentPayloadVaultKeys();
          if (vaultKeys) {
            const vault = createPaymentPayloadVault(vaultKeys.activeKeyId, vaultKeys.keyRing);
            const inbox = createPaymentWebhookService(db as never, vault, { reconcileDelayMs: 60_000 });
            const verification = createPaymentVerificationService({
              database: db as never,
              config,
              provider: createSafepayProvider(config),
              reconciliation: createPaymentReconciliationService(db as never, inbox),
            });
            const outcome = await verification.verifyPaymentNow(result.paymentId);
            console.info("[Safepay return] RETURN_VERIFY", { outcome: outcome.kind });
            if (outcome.kind !== "skipped" && outcome.kind !== "provider_fetch_failed") {
              // Re-read the snapshot: settlement (or a recorded observation) may have
              // changed the displayed state.
              result = await readReturn({
                ...(context.kind === "state-only" || context.kind === "full" ? { state: context.state } : {}),
                ...(context.kind === "tracker-only" || context.kind === "full" ? { tracker: context.trackerToken } : {}),
                owner: { kind: "USER", userId: user.id },
              });
            }
          }
        } catch {
          // Verification is best-effort on this page; the scheduled worker and the
          // admin re-check action retry safely. Never surface transport details.
          console.warn("[Safepay return] RETURN_VERIFY_UNAVAILABLE");
        }
      }
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
      message: `Order ${result.kind === "pending" ? result.reference : ""} is awaiting secure server-side payment verification. This page is not proof of payment. Verification with Safepay runs automatically (or retry this page in a minute) — please do not start another payment attempt.`,
      tone: "border-amber-200 bg-amber-50 text-amber-950",
    },
    failure: {
      title: "Payment not completed",
      message: `The payment for order ${result.kind === "failure" ? result.reference : ""} is recorded as failed. The order has not been confirmed.`,
      tone: "border-red-200 bg-red-50 text-red-900",
    },
    invalid: {
      title: "Return could not be verified",
      message:
        "We could not verify this Safepay return. Sign in with the checkout account and check your order status.",
      tone: "border-border bg-muted text-foreground",
    },
  }[result.kind];

  return (
    <main className="container-khd max-w-2xl py-16">
      <section
        className={`rounded-xl border p-6 text-center sm:p-8 ${content.tone}`}
        aria-live="polite"
      >
        <h1 className="text-2xl font-bold">{content.title}</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6">
          {content.message}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            className="rounded-md border px-4 py-2 text-sm font-medium"
            href="/account/orders"
          >
            View my orders
          </Link>
          <Link
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            href="/"
          >
            Continue shopping
          </Link>
        </div>
      </section>
    </main>
  );
}

type PaymentRow = {
  id: string;
  status: string;
  attemptState: string | null;
  reconcileStatus: string | null;
  paidVerifiedAt: Date | null;
  order: { reference: string; paymentStatus: string; acceptedPaymentId: string | null };
};

function snapshotFrom(payment: PaymentRow) {
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
}
