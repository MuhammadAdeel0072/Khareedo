import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSafepayConfig } from "@/lib/safepay/config";
import {
  createSafepayWebhookAdapter,
  type SafepayAttemptContext,
} from "@/lib/safepay/verification";

const SECRET = "synthetic-webhook-secret-0123456789abcdef";

const config = loadSafepayConfig({
  SAFEPAY_ENVIRONMENT: "sandbox",
  SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public",
  SAFEPAY_SECRET_KEY: "synthetic-merchant-secret",
  SAFEPAY_RETURN_STATE_SECRET:
    "synthetic-independent-return-key-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account",
  SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
});

const attempt: SafepayAttemptContext = {
  orderId: "order-1",
  paymentId: "payment-1",
  attemptNumber: 1,
  currency: "PKR",
  expectedAmountMinor: "100000",
  owner: {
    kind: "USER",
    hash: "a".repeat(64),
    userId: "user-1",
  },
};

const adapter = createSafepayWebhookAdapter(
  config,
  SECRET,
  async tracker => tracker === "TCKR_OK" ? attempt : null
);

const timestamp = {
  seconds: 1698758038,
  nanos: 682810001,
};

function payload(
  type: string,
  data: Record<string, unknown>,
  token = "evt_refund_test_1",
  merchant = "synthetic-public"
) {
  return JSON.stringify({
    token,
    version: "2.0.0",
    merchant_api_key: merchant,
    type,
    endpoint: "https://shop.example.invalid/api/webhooks/safepay",
    data,
    created_at: timestamp,
  });
}

function signed(body: string, secret = SECRET) {
  return {
    provider: "SAFEPAY" as const,
    environment: "sandbox" as const,
    merchantAccountRef: "synthetic-account",
    channel: "WEBHOOK" as const,
    body: Buffer.from(body),
    headers: {
      "x-sfpy-signature": createHmac("sha512", secret)
        .update(Buffer.from(body))
        .digest("hex"),
    },
  };
}

function refundData(overrides: Record<string, unknown> = {}) {
  return {
    tracker: "TCKR_OK",
    intent: "CYBERSOURCE",
    state: "TRACKER_PARTIAL_REFUND",
    refund_amount: 1000,
    balance: 99000,
    currency: "PKR",
    refunded_at: timestamp,
    ...overrides,
  };
}

describe("Safepay refund, reversal and void security", () => {
  it("authenticates a partial refund amount for settlement to validate against the ledger", async () => {
    const result = await adapter.verify(
      signed(payload("payment.refunded", refundData()))
    );

    expect(result).toMatchObject({
      kind: "authenticated",
      observation: {
        paymentId: "payment-1",
        kind: "REFUND_CONFIRMED",
        amountMinor: "0",
        capturedMinor: null,
        refundMinor: "1000",
        currency: "PKR",
      },
    });
  });

  it("classifies a full refund as authenticated refund evidence", async () => {
    const result = await adapter.verify(
      signed(payload("payment.refunded", refundData({
        state: "TRACKER_REFUNDED",
        refund_amount: 100000,
        balance: 0,
      }), "evt_full_refund"))
    );

    expect(result).toMatchObject({
      kind: "authenticated",
      observation: {
        kind: "REFUND_CONFIRMED",
        refundMinor: "100000",
        capturedMinor: null,
      },
    });
  });

  it("recognizes an authorization reversal without inventing financial amounts", async () => {
    const result = await adapter.verify(
      signed(payload("authorization.reversed", {
        tracker: "TCKR_OK",
        state: "TRACKER_REVERSED",
        reversed_authorization_id: "auth_test_123",
        reversed_at: timestamp,
      }, "evt_reversal"))
    );

    expect(result).toMatchObject({
      kind: "authenticated",
      observation: {
        kind: "REVERSAL_NOTICE",
        amountMinor: null,
        capturedMinor: null,
        refundMinor: null,
      },
    });
  });

  it("recognizes a void without assuming a refund or capture reversal amount", async () => {
    const result = await adapter.verify(
      signed(payload("void.succeeded", {
        tracker: "TCKR_OK",
        state: "TRACKER_VOIDED",
        void_type: "CAPTURE",
        voided_charge_id: "cap_test_123",
        voided_at: timestamp,
      }, "evt_void"))
    );

    expect(result).toMatchObject({
      kind: "authenticated",
      observation: {
        kind: "REVERSAL_NOTICE",
        amountMinor: null,
        capturedMinor: null,
        refundMinor: null,
      },
    });
  });

  it("routes unknown refund states to review rather than assuming refund finality", async () => {
    const result = await adapter.verify(
      signed(payload("payment.refunded", refundData({
        state: "TRACKER_UNKNOWN",
      }), "evt_unknown_refund"))
    );

    expect(result).toMatchObject({
      kind: "authenticated",
      observation: {
        kind: "REVIEW_REQUIRED",
        capturedMinor: null,
      },
    });
  });

  it("rejects missing, excessive, fractional or invalid refund financial fields", async () => {
    const invalid = [
      { refund_amount: 0 },
      { refund_amount: -100 },
      { refund_amount: 100001 },
      { refund_amount: 1.5 },
      { refund_amount: undefined },
      { balance: undefined },
      { balance: -1 },
      { currency: "USD" },
      { refunded_at: undefined },
    ];

    for (const [index, overrides] of invalid.entries()) {
      const result = await adapter.verify(
        signed(payload("payment.refunded", refundData(overrides),
          `evt_invalid_${index}`))
      );

      expect(result.kind, JSON.stringify(overrides)).toBe("rejected");
    }
  });

  it("rejects events from a foreign merchant or unknown tracker", async () => {
    const foreign = payload(
      "payment.refunded",
      refundData(),
      "evt_foreign",
      "foreign-merchant"
    );

    const unknown = payload(
      "payment.refunded",
      refundData({ tracker: "UNKNOWN_TRACKER" }),
      "evt_unknown_tracker"
    );

    expect((await adapter.verify(signed(foreign))).kind)
      .toBe("rejected");

    expect((await adapter.verify(signed(unknown))).kind)
      .toBe("rejected");
  });

  it("rejects invalid signatures and body changes made after signing", async () => {
    const original = payload("payment.refunded", refundData());

    expect((await adapter.verify(signed(original, "wrong-secret"))).kind)
      .toBe("rejected");

    const tampered = signed(original);
    tampered.body = Buffer.from(
      original.replace('"refund_amount":1000', '"refund_amount":2000')
    );

    expect((await adapter.verify(tampered)).kind)
      .toBe("rejected");
  });

  it("rejects malformed reversal and void payloads", async () => {
    const invalidCases = [
      payload("authorization.reversed", {
        tracker: "TCKR_OK",
        state: "TRACKER_REVERSED",
        reversed_at: timestamp,
      }, "evt_bad_reversal"),

      payload("void.succeeded", {
        tracker: "TCKR_OK",
        state: "TRACKER_VOIDED",
        voided_at: timestamp,
      }, "evt_bad_void"),
    ];

    for (const body of invalidCases) {
      expect((await adapter.verify(signed(body))).kind)
        .toBe("rejected");
    }
  });

  it("derives stable event identity for redelivered refund notices", async () => {
    const body = payload("payment.refunded", refundData());

    const first = await adapter.verify(signed(body));
    const second = await adapter.verify(signed(body));

    expect(first.kind).toBe("authenticated");
    expect(second.kind).toBe("authenticated");

    if (first.kind !== "authenticated" ||
        second.kind !== "authenticated") return;

    expect(first.observation).toMatchObject({
      observationId: "evt_refund_test_1",
    });

    expect(second.observation).toEqual(first.observation);
  });
});
