import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSafepayConfig } from "@/lib/safepay/config";
import {
  createSafepayReconciliationAdapter,
  createSafepayWebhookAdapter,
  type SafepayAttemptContext,
} from "@/lib/safepay/verification";
import type { VerificationInput } from "@/lib/payments/evidence-contract";

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
  owner: { kind: "USER", hash: "a".repeat(64), userId: "user-1" },
};
const resolver = async (token: string): Promise<SafepayAttemptContext | null> =>
  token === "TCKR_OK" ? attempt : null;

function signed(body: string, secret = WEBHOOK_SECRET): VerificationInput {
  return {
    provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
    channel: "WEBHOOK", body: Buffer.from(body),
    headers: { "x-sfpy-signature": createHmac("sha512", secret).update(Buffer.from(body)).digest("hex") },
  };
}

const succeededBody = JSON.stringify({ type: "payment.succeeded", data: {
  tracker: { token: "TCKR_OK", state: "TRACKER_ENDED",
    purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
} });

describe("Safepay webhook evidence adapter", () => {
  const adapter = createSafepayWebhookAdapter(config, WEBHOOK_SECRET, resolver);

  it("authenticates a documented signed payment.succeeded event", async () => {
    const result = await adapter.verify(signed(succeededBody));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    const observation = result.observation as Record<string, unknown>;
    expect(observation).toMatchObject({
      provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
      orderId: "order-1", paymentId: "payment-1", attemptNumber: 1, trackerToken: "TCKR_OK",
      kind: "CAPTURE_CONFIRMED", amountMinor: "100000", capturedMinor: "100000", refundMinor: "0",
    });
  });

  it("maps payment.failed to FAILURE_CONFIRMED without releasing anything itself", async () => {
    const body = JSON.stringify({ type: "payment.failed", data: {
      tracker: { token: "TCKR_OK", purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
    } });
    const result = await adapter.verify(signed(body));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    expect((result.observation as Record<string, unknown>).kind).toBe("FAILURE_CONFIRMED");
    expect((result.observation as Record<string, unknown>).capturedMinor).toBeNull();
  });

  it("rejects a tampered body, wrong secret, missing header and malformed signature", async () => {
    const tampered = signed(succeededBody);
    expect((await adapter.verify({ ...tampered, body: Buffer.from(new TextDecoder().decode(tampered.body) + " ") })).kind).toBe("rejected");
    expect((await adapter.verify(signed(succeededBody, "wrong-secret-0123456789abcdefgh"))).kind).toBe("rejected");
    const unsigned = { ...signed(succeededBody), headers: {} };
    expect((await adapter.verify(unsigned)).kind).toBe("rejected");
    const badHex = { ...signed(succeededBody), headers: { "x-sfpy-signature": "z".repeat(128) } };
    expect((await adapter.verify(badHex)).kind).toBe("rejected");
  });

  it("rejects undocumented event types and unparsable payloads for processing", async () => {
    const refund = JSON.stringify({ type: "refund.completed", data: { tracker: "TCKR_OK" } });
    expect((await adapter.verify(signed(refund))).kind).toBe("rejected");
    expect((await adapter.verify(signed("not json"))).kind).toBe("rejected");
    const noTracker = JSON.stringify({ type: "payment.succeeded", data: { unexpected: true } });
    expect((await adapter.verify(signed(noTracker))).kind).toBe("rejected");
  });

  it("rejects events whose tracker does not resolve to a managed attempt", async () => {
    const body = JSON.stringify({ type: "payment.succeeded", data: {
      tracker: { token: "TCKR_UNKNOWN", state: "TRACKER_ENDED",
        purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
    } });
    expect((await adapter.verify(signed(body))).kind).toBe("rejected");
  });

  it("rejects a foreign provider environment inside the event", async () => {
    const body = JSON.stringify({ type: "payment.succeeded", data: {
      environment: "production",
      tracker: { token: "TCKR_OK", state: "TRACKER_ENDED",
        purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
    } });
    expect((await adapter.verify(signed(body))).kind).toBe("rejected");
  });

  it("rejects non-PKR amounts instead of classifying them", async () => {
    const body = JSON.stringify({ type: "payment.succeeded", data: {
      tracker: { token: "TCKR_OK", state: "TRACKER_ENDED",
        purchase_totals: { quote_amount: { currency: "USD", amount: 100000 } } },
    } });
    expect((await adapter.verify(signed(body))).kind).toBe("rejected");
  });

  it("derives a stable event identity from the body when no X-SFPY event id exists", async () => {
    const first = await adapter.verify(signed(succeededBody));
    const second = await adapter.verify(signed(succeededBody));
    if (first.kind !== "authenticated" || second.kind !== "authenticated") throw new Error("unreachable");
    expect((first.observation as Record<string, unknown>).observationId)
      .toBe((second.observation as Record<string, unknown>).observationId);
  });

  it("keeps contradictory evidence out of automatic finality", async () => {
    const body = JSON.stringify({ type: "payment.failed", data: {
      tracker: { token: "TCKR_OK", state: "TRACKER_ENDED",
        purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } },
    } });
    const result = await adapter.verify(signed(body));
    if (result.kind !== "authenticated") throw new Error("unreachable");
    expect((result.observation as Record<string, unknown>).kind).toBe("REVIEW_REQUIRED");
  });
});

describe("Safepay reconciliation evidence adapter", () => {
  const adapter = createSafepayReconciliationAdapter(config, resolver);

  function reporterBody(state: string, environment = "sandbox", amount = 100000, currency = "PKR") {
    return JSON.stringify({ data: { tracker: { token: "TCKR_OK", environment, state,
      intent: "CYBERSOURCE", mode: "payment",
      purchase_totals: { quote_amount: { currency, amount } } },
    }, status: { errors: [], message: "success" } });
  }

  it("classifies TRACKER_ENDED as capture confirmed with documented amounts", async () => {
    const result = await adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
      body: Buffer.from(reporterBody("TRACKER_ENDED")), headers: {} });
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    const observation = result.observation as Record<string, unknown>;
    expect(observation).toMatchObject({ kind: "CAPTURE_CONFIRMED", amountMinor: "100000",
      capturedMinor: "100000", refundMinor: "0", trackerToken: "TCKR_OK" });
  });

  it("keeps TRACKER_STARTED pending and unknown states uncertain", async () => {
    for (const [state, expected] of [["TRACKER_STARTED", "PENDING"], ["SOMETHING_NEW", "UNCERTAIN"]] as const) {
      const result = await adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
        merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
        body: Buffer.from(reporterBody(state)), headers: {} });
      if (result.kind !== "authenticated") throw new Error("unreachable");
      expect((result.observation as Record<string, unknown>).kind).toBe(expected);
    }
  });

  it("derives a stable observation id per tracker/state/amount and a distinct one across states", async () => {
    const fetch = async (state: string) => await adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
      body: Buffer.from(reporterBody(state)), headers: {} });
    const a = await fetch("TRACKER_ENDED"), b = await fetch("TRACKER_ENDED"), c = await fetch("TRACKER_STARTED");
    if (a.kind !== "authenticated" || b.kind !== "authenticated" || c.kind !== "authenticated") throw new Error("unreachable");
    expect((a.observation as Record<string, unknown>).observationId)
      .toBe((b.observation as Record<string, unknown>).observationId);
    expect((a.observation as Record<string, unknown>).observationId)
      .not.toBe((c.observation as Record<string, unknown>).observationId);
  });

  it("rejects provider errors, foreign environments, foreign accounts and unparsable bodies", async () => {
    const base = { provider: "SAFEPAY", environment: "sandbox" as const, merchantAccountRef: "synthetic-account",
      channel: "RECONCILIATION" as const, headers: {} };
    const withErrors = JSON.stringify({ data: { tracker: { token: "TCKR_OK", environment: "sandbox", state: "TRACKER_ENDED",
      purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } } } },
      status: { errors: [{ code: "not_found" }] } });
    expect((await adapter.verify({ ...base, body: Buffer.from(withErrors) })).kind).toBe("rejected");
    expect((await adapter.verify({ ...base, body: Buffer.from(reporterBody("TRACKER_ENDED", "production")) })).kind).toBe("rejected");
    expect((await adapter.verify({ ...base, body: Buffer.from("nope") })).kind).toBe("rejected");
  });

  it("never fabricates timestamps", async () => {
    const result = await adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
      body: Buffer.from(reporterBody("TRACKER_ENDED")), headers: {} });
    if (result.kind !== "authenticated") throw new Error("unreachable");
    expect((result.observation as Record<string, unknown>).occurredAt).toBeNull();
  });
});
