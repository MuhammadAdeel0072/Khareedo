// Payment-method selection rules (FR-19/20) — pure, unit-tested helpers.
//
// Single source of truth for which payment methods are eligible for an order
// and which one is pre-selected. The server independently re-validates the
// chosen method against store settings (checkout.service), so these helpers
// can never bypass business rules — they only keep the UI consistent with
// them (HCI: an obvious default, no dead-ends, no double-click selection).

export const PAYMENT_METHOD_IDS = ["COD", "BANK_TRANSFER", "ONLINE"] as const;
export type CheckoutPaymentMethod = (typeof PAYMENT_METHOD_IDS)[number];

export interface PaymentEligibility {
  codEnabled: boolean;
  bankTransferEnabled: boolean;
  sandboxPaymentEnabled: boolean;
}

/** Preference order — Cash on Delivery first, per business rules. */
const PREFERENCE: readonly CheckoutPaymentMethod[] = [
  "COD",
  "BANK_TRANSFER",
  "ONLINE",
];

/** Methods currently enabled for the store, in preference order. */
export function availablePaymentMethods(
  eligibility: PaymentEligibility
): CheckoutPaymentMethod[] {
  return PREFERENCE.filter((method) => {
    if (method === "COD") return eligibility.codEnabled;
    if (method === "BANK_TRANSFER") return eligibility.bankTransferEnabled;
    return eligibility.sandboxPaymentEnabled;
  });
}

/**
 * Initial selection: the first eligible method in preference order
 * (COD preferred when enabled). Returns null when nothing is eligible —
 * the UI must then explain and block continuing instead of guessing.
 */
export function defaultPaymentMethod(
  eligibility: PaymentEligibility
): CheckoutPaymentMethod | null {
  return availablePaymentMethods(eligibility)[0] ?? null;
}

/** Type guard — is this string an eligible, enabled method right now? */
export function isEligiblePaymentMethod(
  method: string | null | undefined,
  eligibility: PaymentEligibility
): method is CheckoutPaymentMethod {
  if (!method) return false;
  return (availablePaymentMethods(eligibility) as readonly string[]).includes(method);
}
