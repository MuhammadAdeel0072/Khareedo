import "server-only";
import type { PaymentVerificationAdapter, VerificationInput } from "@/lib/payments/evidence-contract";
import {
  createSafepayReconciliationAdapter,
  createSafepayWebhookAdapter,
} from "@/lib/safepay/verification";
import { loadSafepayConfig, loadSafepayWebhookSecret, SafepayConfigurationError } from "@/lib/safepay/config";
import { trackerIdentity } from "@/lib/payments/evidence-contract";
import { db } from "@/lib/db";

// Sandbox-scoped code gate for authenticated payment evidence. Production verification
// remains hard-disabled below until the merchant approval, hosted profile, financial
// finality and PostgreSQL deployment blockers (see lib/safepay/readiness.ts) clear.
// No environment variable, HTTP body, DB flag or injected adapter can widen this scope.
export const PAYMENT_PROVIDER_VERIFICATION_ENABLED = true as const;
export const PAYMENT_PROVIDER_VERIFICATION_ENVIRONMENT = "sandbox" as const;

// Resolves a provider tracker token to the local managed attempt it belongs to.
// Only LOCAL identity facts come from the database; every PROVIDER fact (state,
// amounts, currency) comes exclusively from the authenticated payload. Settlement
// re-validates the merged observation against the same rows before any money moves.
async function resolveSafepayTracker(trackerToken: string) {
  const config = loadSafepayConfig();
  const payment = await db.payment.findFirst({
    where: {
      provider: "SAFEPAY",
      providerEnvironment: config.environment,
      trackerIdentityKey: trackerIdentity({
        provider: "SAFEPAY", environment: config.environment,
        merchantAccountRef: config.merchantAccountRef, trackerToken,
      }),
    },
    select: {
      id: true, orderId: true, attemptNumber: true, currency: true,
      // Locally expected amount: adapters validate provider-reported amounts against it
      // and never substitute it for a missing provider-reported amount.
      expectedAmountMinor: true,
      order: {
        select: {
          paymentFlowVersion: true, checkoutOwnerKind: true,
          checkoutOwnerHash: true, userId: true, isGuest: true,
        },
      },
    },
  });
  const order = payment?.order;
  if (!payment || !order || order.paymentFlowVersion !== 1 || !payment.attemptNumber ||
      payment.attemptNumber < 1 || payment.currency !== "PKR" || !payment.expectedAmountMinor ||
      order.isGuest ||
      order.checkoutOwnerKind !== "USER" || !order.userId || !order.checkoutOwnerHash ||
      !/^[a-f0-9]{64}$/.test(order.checkoutOwnerHash)) return null;
  return {
    orderId: payment.orderId, paymentId: payment.id, attemptNumber: payment.attemptNumber,
    currency: payment.currency,
    expectedAmountMinor: payment.expectedAmountMinor.toString(),
    owner: { kind: "USER" as const, hash: order.checkoutOwnerHash, userId: order.userId },
  };
}

// Safepay evidence adapters, approved for the sandbox environment only. The merchant
// account ref and environment of the incoming evidence must match the configured
// server scope exactly, or the evidence is not ours to judge.
export function approvedPaymentVerifier(input: VerificationInput): PaymentVerificationAdapter | null {
  if (!input || input.provider !== "SAFEPAY") return null;
  if (input.environment !== PAYMENT_PROVIDER_VERIFICATION_ENVIRONMENT) return null;
  if (input.channel !== "WEBHOOK" && input.channel !== "RECONCILIATION") return null;
  try {
    const config = loadSafepayConfig();
    if (config.environment !== PAYMENT_PROVIDER_VERIFICATION_ENVIRONMENT) return null;
    if (config.merchantAccountRef !== input.merchantAccountRef) return null;
    if (input.channel === "RECONCILIATION") {
      return createSafepayReconciliationAdapter(config, resolveSafepayTracker);
    }
    const webhookSecret = loadSafepayWebhookSecret();
    if (!webhookSecret) return null;
    return createSafepayWebhookAdapter(config, webhookSecret, resolveSafepayTracker);
  } catch (error) {
    if (error instanceof SafepayConfigurationError) return null;
    return null;
  }
}
