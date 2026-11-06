import "server-only";
import type { PaymentVerificationAdapter, VerificationInput } from "@/lib/payments/evidence-contract";

export const PAYMENT_PROVIDER_VERIFICATION_ENABLED = false as const;

// Hard code gate. No environment variable, HTTP body, DB flag or injected adapter can approve a provider.
// Safepay signed bytes, merchant binding, event identity/replay rules and financial finality remain unconfirmed.
// Tests mock this registry module with a synthetic verifier; no test bypass ships in application code.
export function approvedPaymentVerifier(_input: VerificationInput): PaymentVerificationAdapter | null {
  return null;
}
