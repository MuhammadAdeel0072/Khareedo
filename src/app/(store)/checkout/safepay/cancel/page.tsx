import Link from "next/link";
import { cookies, headers } from "next/headers";
import { getSessionUser } from "@/lib/auth-guard";
import {
  loadSafepayConfig,
  SafepayConfigurationError,
} from "@/lib/safepay/config";
import {
  parseSafepayReturnContext,
  SAFEPAY_RETURN_STATE_COOKIE,
} from "@/lib/safepay/return-input";
import { requestOrigin } from "@/lib/request-origin";
import { db } from "@/lib/db";
import {
  resolveSafepayCancel,
  type SafepayCancelOutcome,
} from "@/services/safepay-cancel.service";

export const dynamic = "force-dynamic";

type SearchParams = { state?: string | string[]; tracker?: string | string[] };

export default async function SafepayCancelPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  const cookieStore = await cookies();
  const context = parseSafepayReturnContext(params, cookieStore.get(SAFEPAY_RETURN_STATE_COOKIE)?.value);

  // Diagnostics intentionally log sources and presence only — never param values.
  console.info("[Safepay cancel] REQUEST_CHECK", {
    hasUser: Boolean(user),
    contextKind: context.kind,
  });

  // The cancel return closes the local reservation through the existing
  // owner-bound reservation service (H-2). The close is idempotent
  // (ALREADY_CLOSED on a repeat visit), so a refresh or double render can
  // never double-release. Local release only: no provider reversal is
  // called — nothing was captured on a cancelled checkout (D6 pending).
  let result: SafepayCancelOutcome = { kind: "invalid" };
  if (user && context.kind !== "empty") {
    let config;
    try {
      config = loadSafepayConfig(process.env, requestOrigin(await headers()) ?? undefined);
    } catch (error) {
      console.warn("[Safepay cancel] CONFIGURATION_UNAVAILABLE");
      if (!(error instanceof SafepayConfigurationError)) throw error;
    }
    if (config) {
      try {
        result = await resolveSafepayCancel({
          config,
          database: db as never,
          query: params,
          cookieState: cookieStore.get(SAFEPAY_RETURN_STATE_COOKIE)?.value,
          owner: { kind: "USER", userId: user.id },
        });
      } catch {
        // The reservation close must never crash the page: an unclosed
        // reservation is expired by the maintenance worker, and the order
        // stays visible in the customer's order list.
        console.warn("[Safepay cancel] CANCEL_UNAVAILABLE");
        result = { kind: "close_failed", reference: null };
      }
      console.info("[Safepay cancel] OUTCOME", { kind: result.kind });
    }
  }

  const content = {
    released: {
      title: "Payment checkout cancelled",
      message:
        "You cancelled checkout before paying. No payment was taken and your reservation has been released — the items are back in stock.",
      tone: "border-warning/30 bg-warning/10 text-warning-dark",
    },
    review_required: {
      title: "Cancellation recorded — payment under review",
      message:
        "You cancelled checkout, but a payment attempt had already started, so we could not confirm whether any payment went through. Your order is held for payment review — no further action is needed from you. Check your orders for updates.",
      tone: "border-warning/30 bg-warning/10 text-warning-dark",
    },
    already_closed: {
      title: "Checkout already cancelled",
      message: "This checkout was already cancelled and its reservation released.",
      tone: "border-border bg-muted text-foreground",
    },
    close_failed: {
      title: "Cancellation could not be completed",
      message:
        "We could not close this checkout safely. Your order is held for payment review — please check your orders or contact support.",
      tone: "border-destructive/30 bg-destructive/10 text-destructive",
    },
    invalid: {
      title: "Cancellation could not be verified",
      message:
        "We could not verify this Safepay cancellation. Sign in with the checkout account and check your order status — an unconfirmed reservation expires automatically.",
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
