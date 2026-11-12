import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSafepayConfig } from "@/lib/safepay/config";
import {
  createSafepayReconciliationAdapter,
  createSafepayWebhookAdapter,
  type SafepayAttemptContext,
} from "@/lib/safepay/verification";
import type { VerificationInput } from "@/lib/payments/evidence-contract";

// Adapter-level classification tests for documented refund and reversal evidence:
// the payment.refunded webhook, void.succeeded / authorization.reversed events, and the
// TRACKER_REFUNDED / TRACKER_PARTIAL_REFUND / TRACKER_REVERSED reporter states. All
// webhook bodies below are signed with the documented HMAC-SHA512/hex contract; these
// tests verify classification only, not end-to-end settlement (see the integration suite).
const config = loadSafepayConfig({
  SAFEPAY_ENVIRONMENT: "sandbox",
  SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public",
  SAFEPAY_SECRET_KEY: "synthetic-merchant-secret",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-independent-return-key-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account",
  SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
});
const WEBHOOK_SECRET = "synthetic-webhook-secret-0123456789abcdef";

const attempt: SafepayAttemptContext = {
  orderId: "order-1", paymentId: "payment-1", attemptNumber: 1, currency: "PKR",
  expectedAmountMinor: "100000",
  owner: { kind: "USER", hash: "a".repeat(64), userId: "user-1" },
};
const resolver = async (token: string): Promise<SafepayAttemptContext | null> =>
  token === "TCKR_OK" ? attempt : null;

function signed(body: string, secret = WEBHOOK_SECRET, headers: Record<string, string> = {}): VerificationInput {
  return {
    provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    channel: "WEBHOOK", body: Buffer.from(body),
    headers: { "x-sfpy-signature": createHmac("sha512", secret).update(Buffer.from(body)).digest("hex"), ...headers },
  };
}

function refundedBody(overrides: Record<string, unknown> = {}, trackerOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "payment.refunded", data: {
    tracker: { token: "TCKR_OK", state: "TRACKER_REFUNDED",
      purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } }, ...trackerOverrides },
    refund_amount: 100000, balance: 0, refunded_at: { seconds: 1_760_000_000, nanos: 0 },
    ...overrides,
  } });
}

describe("Safepay webhook adapter: payment.refunded", () => {
  const adapter = createSafepayWebhookAdapter(config, WEBHOOK_SECRET, resolver);

  it("authenticates a signed full refund event into REFUND_CONFIRMED with the refund amount", async () => {
    const result = await adapter.verify(signed(refundedBody()));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    const observation = result.observation as Record<string, unknown>;
    expect(observation).toMatchObject({
      provider: "SAFEPAY", orderId: "order-1", paymentId: "payment-1", trackerToken: "TCKR_OK",
      kind: "REFUND_CONFIRMED", amountMinor: "100000", capturedMinor: null,
      refundMinor: "100000", providerState: "TRACKER_REFUNDED",
      occurredAt: new Date(1_760_000_000 * 1000).toISOString(),
    });
  });

  it("authenticates a partial refund event (TRACKER_PARTIAL_REFUND) with its own amount", async () => {
    const body = refundedBody({ refund_amount: 25000, balance: 75000 },
      { state: "TRACKER_PARTIAL_REFUND" });
    const result = await adapter.verify(signed(body));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    expect(result.observation).toMatchObject({ kind: "REFUND_CONFIRMED", refundMinor: "25000",
      providerState: "TRACKER_PARTIAL_REFUND" });
  });

  it("accepts a later partial refund without assuming balance is original minus this event only", async () => {
    const body = refundedBody({ refund_amount: 25000, balance: 50000 },
      { state: "TRACKER_PARTIAL_REFUND" });
    const result = await adapter.verify(signed(body));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    expect(result.observation).toMatchObject({ kind: "REFUND_CONFIRMED", refundMinor: "25000" });
  });

  it("accepts the string-tracker payload form when currency, balance and timestamp are verified", async () => {
    const body = JSON.stringify({ type: "payment.refunded",
      data: { tracker: "TCKR_OK", state: "TRACKER_PARTIAL_REFUND", refund_amount: 1000,
        balance: 99000, currency: "PKR", refunded_at: { seconds: 1_760_000_000, nanos: 0 } } });
    const result = await adapter.verify(signed(body));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    expect(result.observation).toMatchObject({ kind: "REFUND_CONFIRMED", refundMinor: "1000",
      amountMinor: "0" }); // "0" = quote not asserted by this evidence
  });

  it("rejects refund events without a parsable positive refund amount", async () => {
    expect((await adapter.verify(signed(JSON.stringify({ type: "payment.refunded",
      data: { tracker: { token: "TCKR_OK" } } })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(refundedBody({ refund_amount: 0 })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(refundedBody({ refund_amount: -5 })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(refundedBody({ refund_amount: 1.5 })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(refundedBody({ refund_amount: "100000" })))).kind).toBe("rejected");
  });

  it("rejects refund events with a present-but-invalid balance and unknown trackers", async () => {
    expect((await adapter.verify(signed(refundedBody({ balance: "zero" })))).kind).toBe("rejected");
    const unknownTracker = refundedBody({}, { token: "TCKR_UNKNOWN" });
    expect((await adapter.verify(signed(unknownTracker))).kind).toBe("rejected");
  });

  it("rejects refund events for a non-PKR currency", async () => {
    const body = refundedBody({}, { purchase_totals: { quote_amount: { currency: "USD", amount: 100000 } } });
    expect((await adapter.verify(signed(body))).kind).toBe("rejected");
  });

  it("routes a refund event whose tracker state contradicts a refund to review with the amount intact", async () => {
    const body = refundedBody({}, { state: "TRACKER_ENDED" });
    const result = await adapter.verify(signed(body));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    expect(result.observation).toMatchObject({ kind: "REVIEW_REQUIRED", refundMinor: "100000",
      providerState: "TRACKER_ENDED" });
  });

  it("rejects tampered bodies and wrong signatures before any parsing", async () => {
    const tampered = signed(refundedBody());
    expect((await adapter.verify({ ...tampered,
      body: Buffer.from(new TextDecoder().decode(tampered.body) + " ") })).kind).toBe("rejected");
    expect((await adapter.verify(signed(refundedBody(), "wrong-secret-0123456789abcdefgh"))).kind).toBe("rejected");
  });

  it("derives stable identity from signed body bytes and ignores the unsigned event-id header", async () => {
    const body = refundedBody();
    const first = await adapter.verify(signed(body));
    const second = await adapter.verify(signed(body));
    if (first.kind !== "authenticated" || second.kind !== "authenticated") throw new Error("expected authenticated");
    expect((first.observation as Record<string, unknown>).observationId)
      .toBe((second.observation as Record<string, unknown>).observationId);
    const withHeader = await adapter.verify(signed(body, WEBHOOK_SECRET, { "x-sfpy-event-id": "evt_123" }));
    if (withHeader.kind !== "authenticated") throw new Error("expected authenticated");
    expect((withHeader.observation as Record<string, unknown>).observationId)
      .toBe((first.observation as Record<string, unknown>).observationId);
    expect((withHeader.observation as Record<string, unknown>).observationId).not.toBe("evt_123");
  });
});

describe("Safepay webhook adapter: reversal events", () => {
  const adapter = createSafepayWebhookAdapter(config, WEBHOOK_SECRET, resolver);

  it.each(["void.succeeded", "authorization.reversed"])(
    "authenticates %s as REVERSAL_NOTICE without any refund amount", async eventType => {
      const body = JSON.stringify({ type: eventType, data: {
        tracker: { token: "TCKR_OK", state: eventType === "void.succeeded" ? "TRACKER_VOIDED" : "TRACKER_REVERSED" },
        ...(eventType === "void.succeeded"
          ? { void_type: "CAPTURE", voided_charge_id: "charge_1", voided_at: { seconds: 1_760_000_000, nanos: 0 } }
          : { reversed_authorization_id: "auth_1", reversed_at: { seconds: 1_760_000_000, nanos: 0 } }),
      } });
      const result = await adapter.verify(signed(body));
      expect(result.kind).toBe("authenticated");
      if (result.kind !== "authenticated") return;
      expect(result.observation).toMatchObject({ kind: "REVERSAL_NOTICE", capturedMinor: null,
        refundMinor: null, providerState: eventType === "void.succeeded" ? "TRACKER_VOIDED" : "TRACKER_REVERSED" });
    });

  it("rejects reversal events for unknown trackers", async () => {
    const body = JSON.stringify({ type: "void.succeeded", data: { tracker: { token: "TCKR_UNKNOWN" } } });
    expect((await adapter.verify(signed(body))).kind).toBe("rejected");
  });
});

describe("Safepay reconciliation adapter: refund and reversal tracker states", () => {
  const adapter = createSafepayReconciliationAdapter(config, resolver);

  function reporterBody(state: string) {
    return JSON.stringify({ data: { token: "TCKR_OK", environment: "sandbox", state,
      purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
      status: { errors: [] } });
  }

  it("maps TRACKER_REFUNDED to a REFUND_NOTICE with the documented state and no amount", async () => {
    const input: VerificationInput = { provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
      body: Buffer.from(reporterBody("TRACKER_REFUNDED")), headers: {} };
    const result = await adapter.verify(input);
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    expect(result.observation).toMatchObject({ kind: "REFUND_NOTICE", refundMinor: null,
      capturedMinor: null, providerState: "TRACKER_REFUNDED", amountMinor: "100000" });
  });

  it("maps TRACKER_PARTIAL_REFUND to a REFUND_NOTICE and TRACKER_REVERSED to REVERSAL_NOTICE", async () => {
    const partial = await adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
      body: Buffer.from(reporterBody("TRACKER_PARTIAL_REFUND")), headers: {} });
    expect(partial.kind).toBe("authenticated");
    if (partial.kind !== "authenticated") return;
    expect(partial.observation).toMatchObject({ kind: "REFUND_NOTICE", providerState: "TRACKER_PARTIAL_REFUND" });

    const reversed = await adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
      body: Buffer.from(reporterBody("TRACKER_REVERSED")), headers: {} });
    expect(reversed.kind).toBe("authenticated");
    if (reversed.kind !== "authenticated") return;
    expect(reversed.observation).toMatchObject({ kind: "REVERSAL_NOTICE", providerState: "TRACKER_REVERSED" });
  });

  it("keeps an environment-mismatched reporter response rejected", async () => {
    const body = JSON.stringify({ data: { token: "TCKR_OK", environment: "production",
      state: "TRACKER_REFUNDED", purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
      status: { errors: [] } });
    expect((await adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION", body: Buffer.from(body), headers: {} })).kind)
      .toBe("rejected");
  });
});
