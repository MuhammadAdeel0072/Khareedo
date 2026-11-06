import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { loadSafepayConfig } from "@/lib/safepay/config";
import { signReturnState } from "@/lib/safepay/redirect";
import { bindCheckoutOwner } from "@/services/safepay-attempt.store";
import { createSafepayReturnService, type SafepayReturnSnapshot } from "@/services/safepay-return.service";

const config = loadSafepayConfig({
  SAFEPAY_ENVIRONMENT: "sandbox",
  SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public",
  SAFEPAY_SECRET_KEY: "synthetic-secret",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-independent-return-key-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account",
  SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
});
const owner = { kind: "USER" as const, userId: "user-1" };
const ownerHash = bindCheckoutOwner(owner).hash;
const now = Date.now();
const state = signReturnState(config, {
  orderId: "order-1",
  paymentId: "payment-1",
  ownerHash,
  expiresAt: now + 60_000,
}, now);

function snapshot(overrides: Partial<SafepayReturnSnapshot> = {}): SafepayReturnSnapshot {
  return {
    paymentId: "payment-1",
    paymentStatus: "PENDING",
    attemptState: "CHECKOUT_ISSUED",
    reconcileStatus: "PENDING",
    paidVerifiedAt: null,
    orderPaymentStatus: "PENDING",
    acceptedPaymentId: null,
    reference: "KH-TEST",
    ...overrides,
  };
}

describe("Safepay browser return status", () => {
  type ReturnLookup = Parameters<typeof createSafepayReturnService>[1];
  let lookup: Mock<ReturnLookup>;
  let readReturn: ReturnType<typeof createSafepayReturnService>;

  beforeEach(() => {
    lookup = vi.fn<ReturnLookup>(async () => snapshot());
    readReturn = createSafepayReturnService(config, lookup);
  });

  it("shows success only after trusted settlement is persisted", async () => {
    lookup.mockResolvedValue(snapshot({
      paymentStatus: "PAID",
      attemptState: "SETTLED",
      reconcileStatus: "VERIFIED",
      paidVerifiedAt: new Date(),
      orderPaymentStatus: "PAID",
      acceptedPaymentId: "payment-1",
    }));

    await expect(readReturn({ state, tracker: "synthetic-tracker", owner, now }))
      .resolves.toEqual({ kind: "success", reference: "KH-TEST" });
  });

  it("keeps an unsettled payment pending", async () => {
    await expect(readReturn({ state, tracker: "synthetic-tracker", owner, now }))
      .resolves.toEqual({ kind: "pending", reference: "KH-TEST" });
  });

  it("shows failure only for a server-recorded failed payment", async () => {
    lookup.mockResolvedValue(snapshot({
      paymentStatus: "FAILED",
      attemptState: "FAILED",
      reconcileStatus: "FAILED",
      orderPaymentStatus: "FAILED",
    }));

    await expect(readReturn({ state, tracker: "synthetic-tracker", owner, now }))
      .resolves.toEqual({ kind: "failure", reference: "KH-TEST" });
  });

  it("rejects invalid state without looking up an order", async () => {
    await expect(readReturn({ state: "tampered", tracker: "synthetic-tracker", owner, now }))
      .resolves.toEqual({ kind: "invalid" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not accept an apparent provider success without verified payment evidence", async () => {
    lookup.mockResolvedValue(snapshot({ reconcileStatus: "UNCERTAIN" }));

    await expect(readReturn({ state, tracker: "synthetic-tracker", owner, now }))
      .resolves.toEqual({ kind: "pending", reference: "KH-TEST" });
  });
});
