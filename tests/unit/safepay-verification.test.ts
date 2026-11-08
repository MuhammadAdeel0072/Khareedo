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
  expectedAmountMinor: "100000",
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

// Verbatim documented payload shapes (getsafepay/safepay-docs, Developers > Webhooks >
// Webhook structure and types): envelope {token, version, merchant_api_key, type,
// endpoint, data, created_at}; payment.succeeded data carries data.tracker as a STRING
// with state/amount/currency as sibling fields; payment.failed data carries no amount
// or currency at all and the official example state is TRACKER_ENROLLED.
// Override convention: a key set to null is deleted from the payload (field absent);
// any other value replaces the documented default.
function documentedSucceededBody(overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}): string {
  const data: Record<string, unknown> = {
    tracker: "TCKR_OK",
    intent: "CYBERSOURCE",
    state: "TRACKER_ENDED",
    net: 95250,
    fee: 4750,
    customer_email: "shopper@example.invalid",
    amount: 100000,
    currency: "PKR",
    metadata: { order_id: "KH-TEST", source: "khareedo" },
    charged_at: { seconds: 1698754230, nanos: 752997627 },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete data[key]; else data[key] = value;
  }
  const event: Record<string, unknown> = {
    token: "evt_64b3218e-f65c-45a9-96b0-fe4e293bb879",
    version: "2.0.0",
    merchant_api_key: "synthetic-public",
    type: "payment.succeeded",
    endpoint: "https://shop.example.invalid/api/webhooks/safepay",
    data,
    created_at: { seconds: 1698754230, nanos: 912705711 },
  };
  for (const [key, value] of Object.entries(envelope)) {
    if (value === null) delete event[key]; else event[key] = value;
  }
  return JSON.stringify(event);
}

function documentedFailedBody(overrides: {
  state?: string; omitState?: boolean; token?: string;
} = {}): string {
  return JSON.stringify({
    token: overrides.token ?? "evt_e7069e13-e4a4-4518-b5ce-ee42e62b6797",
    version: "2.0.0",
    merchant_api_key: "synthetic-public",
    type: "payment.failed",
    endpoint: "https://shop.example.invalid/api/webhooks/safepay",
    data: {
      tracker: "TCKR_OK",
      intent: "CYBERSOURCE",
      ...(overrides.omitState ? {} : { state: overrides.state ?? "TRACKER_ENROLLED" }),
      customer_email: "shopper@example.invalid",
      metadata: {},
      category: "PAYMENT_METHOD_ERROR",
      code: 403,
      message: "The card you have used has been flagged as either stolen or lost.",
      failed_at: { seconds: 1698754648, nanos: 494424793 },
    },
    created_at: { seconds: 1698754648, nanos: 589390626 },
  });
}

const CHARGED_ISO = new Date(1698754230 * 1000 + 752).toISOString();
const FAILED_ISO = new Date(1698754648 * 1000 + 494).toISOString();

describe("Safepay webhook evidence adapter — documented payload contract", () => {
  const adapter = createSafepayWebhookAdapter(config, WEBHOOK_SECRET, resolver);

  it("authenticates the documented string-tracker payment.succeeded payload with sibling amount/currency", async () => {
    const result = await adapter.verify(signed(documentedSucceededBody()));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    const observation = result.observation as Record<string, unknown>;
    expect(observation).toMatchObject({
      provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
      orderId: "order-1", paymentId: "payment-1", attemptNumber: 1, trackerToken: "TCKR_OK",
      kind: "CAPTURE_CONFIRMED", amountMinor: "100000", capturedMinor: "100000", refundMinor: "0",
      currency: "PKR", occurredAt: CHARGED_ISO,
    });
  });

  it("derives the observation identity from the documented envelope event token", async () => {
    const first = await adapter.verify(signed(documentedSucceededBody()));
    const second = await adapter.verify(signed(documentedSucceededBody()));
    if (first.kind !== "authenticated" || second.kind !== "authenticated") throw new Error("unreachable");
    expect((first.observation as Record<string, unknown>).observationId)
      .toBe("evt_64b3218e-f65c-45a9-96b0-fe4e293bb879");
    expect((second.observation as Record<string, unknown>).observationId)
      .toBe((first.observation as Record<string, unknown>).observationId);
  });

  it("classifies the documented payment.failed payload (TRACKER_ENROLLED, no amount) as non-final UNCERTAIN", async () => {
    const result = await adapter.verify(signed(documentedFailedBody()));
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    const observation = result.observation as Record<string, unknown>;
    expect(observation.kind).toBe("UNCERTAIN");
    expect(observation.amountMinor).toBeNull();
    expect(observation.capturedMinor).toBeNull();
    expect(observation.refundMinor).toBeNull();
    expect(observation.occurredAt).toBe(FAILED_ISO);
  });

  it("never confirms capture from a missing or non-final tracker state on payment.succeeded", async () => {
    for (const [label, body] of [
      ["missing state", documentedSucceededBody({ state: null })],
      ["TRACKER_STARTED", documentedSucceededBody({ state: "TRACKER_STARTED" })],
      ["unknown state", documentedSucceededBody({ state: "TRACKER_TELEPORTED" })],
    ] as const) {
      const result = await adapter.verify(signed(body));
      if (result.kind !== "authenticated") throw new Error(`rejected: ${label}`);
      expect((result.observation as Record<string, unknown>).kind, label).toBe("REVIEW_REQUIRED");
    }
  });

  it("never confirms failure from missing, started or unknown tracker states on payment.failed", async () => {
    for (const [label, body] of [
      ["missing state", documentedFailedBody({ omitState: true })],
      ["TRACKER_STARTED", documentedFailedBody({ state: "TRACKER_STARTED" })],
      ["unknown state", documentedFailedBody({ state: "TRACKER_TELEPORTED" })],
    ] as const) {
      const result = await adapter.verify(signed(body));
      if (result.kind !== "authenticated") throw new Error(`rejected: ${label}`);
      expect((result.observation as Record<string, unknown>).kind, label).toBe("UNCERTAIN");
      expect((result.observation as Record<string, unknown>).capturedMinor, label).toBeNull();
    }
  });

  it("keeps contradictory evidence out of automatic finality", async () => {
    const failedWhilePaid = await adapter.verify(signed(documentedFailedBody({ state: "TRACKER_ENDED" })));
    if (failedWhilePaid.kind !== "authenticated") throw new Error("unreachable");
    expect((failedWhilePaid.observation as Record<string, unknown>).kind).toBe("REVIEW_REQUIRED");
  });

  it("rejects payment.succeeded payloads without provider-reported financial fields instead of substituting local amounts", async () => {
    expect((await adapter.verify(signed(documentedSucceededBody({ amount: null })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(documentedSucceededBody({ currency: null })))).kind).toBe("rejected");
  });

  it("rejects payment.succeeded amounts that contradict the locally expected attempt amount", async () => {
    expect((await adapter.verify(signed(documentedSucceededBody({ amount: 100001 })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(documentedSucceededBody({ amount: 1 })))).kind).toBe("rejected");
  });

  it("rejects invalid amount shapes and non-PKR currency", async () => {
    expect((await adapter.verify(signed(documentedSucceededBody({ amount: 100000.5 })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(documentedSucceededBody({ amount: -100000 })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(documentedSucceededBody({ amount: "100000" })))).kind).toBe("rejected");
    expect((await adapter.verify(signed(documentedSucceededBody({ currency: "USD" })))).kind).toBe("rejected");
  });

  it("rejects the undocumented tracker-object webhook shape — data.tracker is a documented string", async () => {
    const objectTracker = documentedSucceededBody({ tracker: {
      token: "TCKR_OK", state: "TRACKER_ENDED",
      purchase_totals: { quote_amount: { currency: "PKR", amount: 100000 } },
    } });
    expect((await adapter.verify(signed(objectTracker))).kind).toBe("rejected");
  });

  it("rejects a foreign merchant account and a foreign provider environment", async () => {
    const foreignAccount = documentedSucceededBody({}, { merchant_api_key: "sec_someone-else" });
    expect((await adapter.verify(signed(foreignAccount))).kind).toBe("rejected");
    const foreignEnvironment = JSON.parse(documentedSucceededBody());
    foreignEnvironment.data.environment = "production";
    expect((await adapter.verify(signed(JSON.stringify(foreignEnvironment)))).kind).toBe("rejected");
  });

  it("tolerates an absent merchant_api_key (signature and local tracker binding anchor the account)", async () => {
    const body = documentedSucceededBody({}, { merchant_api_key: null });
    const result = await adapter.verify(signed(body));
    expect(result.kind).toBe("authenticated");
  });

  it("rejects an undocumented webhook generation version", async () => {
    expect((await adapter.verify(signed(documentedSucceededBody({}, { version: "3.0.0" })))).kind).toBe("rejected");
  });

  it("rejects malformed documented timestamps but tolerates absent ones", async () => {
    expect((await adapter.verify(signed(documentedSucceededBody({ charged_at: { seconds: "soon" } })))).kind).toBe("rejected");
    const result = await adapter.verify(signed(documentedSucceededBody({ charged_at: null })));
    if (result.kind !== "authenticated") throw new Error("unreachable");
    const observation = result.observation as Record<string, unknown>;
    expect(observation.kind).toBe("CAPTURE_CONFIRMED");
    expect(observation.occurredAt).toBeNull();
  });

  it("classifies documented signed redeliveries of old events normally — no invented freshness rule", async () => {
    const old = documentedSucceededBody({ charged_at: { seconds: 1600000000, nanos: 1 } });
    const result = await adapter.verify(signed(old));
    if (result.kind !== "authenticated") throw new Error("unreachable");
    expect((result.observation as Record<string, unknown>).kind).toBe("CAPTURE_CONFIRMED");
    expect((result.observation as Record<string, unknown>).occurredAt)
      .toBe(new Date(1600000000 * 1000).toISOString());
  });

  it("rejects a tampered body, wrong secret, missing header and malformed signature", async () => {
    const tampered = signed(documentedSucceededBody());
    expect((await adapter.verify({ ...tampered, body: Buffer.from(new TextDecoder().decode(tampered.body) + " ") })).kind).toBe("rejected");
    expect((await adapter.verify(signed(documentedSucceededBody(), "wrong-secret-0123456789abcdefgh"))).kind).toBe("rejected");
    const unsigned = { ...signed(documentedSucceededBody()), headers: {} };
    expect((await adapter.verify(unsigned)).kind).toBe("rejected");
    const badHex = { ...signed(documentedSucceededBody()), headers: { "x-sfpy-signature": "z".repeat(128) } };
    expect((await adapter.verify(badHex))).toMatchObject({ kind: "rejected" });
  });

  it("rejects undocumented event types and unparsable payloads for processing", async () => {
    for (const type of ["refund.completed", "payment.refunded", "authorization.succeeded", "subscription.payment.failed"]) {
      const body = JSON.stringify({ type, data: { tracker: "TCKR_OK" } });
      expect((await adapter.verify(signed(body))).kind, type).toBe("rejected");
    }
    expect((await adapter.verify(signed("not json"))).kind).toBe("rejected");
    const noTracker = JSON.stringify({ type: "payment.succeeded", data: { unexpected: true } });
    expect((await adapter.verify(signed(noTracker))).kind).toBe("rejected");
  });

  it("rejects events whose tracker does not resolve to a managed attempt", async () => {
    const body = documentedSucceededBody({ tracker: "TCKR_UNKNOWN" });
    expect((await adapter.verify(signed(body))).kind).toBe("rejected");
  });
});

describe("Safepay reconciliation evidence adapter — documented Fetch Tracker contract", () => {
  const adapter = createSafepayReconciliationAdapter(config, resolver);

  // Documented Fetch Tracker response (concepts/fetch-tracker): the tracker fields sit
  // directly under `data` — no "tracker" wrapper, no status.errors envelope.
  function reporterBody(state: string, environment = "sandbox", amount = 100000, currency = "PKR", ok: boolean | undefined = true) {
    return JSON.stringify({
      ...(ok === undefined ? {} : { ok }),
      data: {
        token: "TCKR_OK", environment, state,
        intent: "CYBERSOURCE", mode: "payment", entry_mode: "flex",
        purchase_totals: {
          quote_amount: { currency, amount },
          base_amount: { currency, amount },
        },
      },
    });
  }

  function fetch(state: string, body = reporterBody(state)) {
    return adapter.verify({ provider: "SAFEPAY", environment: "sandbox",
      merchantAccountRef: "synthetic-account", channel: "RECONCILIATION",
      body: Buffer.from(body), headers: {} });
  }

  it("classifies TRACKER_ENDED as capture confirmed with documented amounts", async () => {
    const result = await fetch("TRACKER_ENDED");
    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") return;
    const observation = result.observation as Record<string, unknown>;
    expect(observation).toMatchObject({ kind: "CAPTURE_CONFIRMED", amountMinor: "100000",
      capturedMinor: "100000", refundMinor: "0", trackerToken: "TCKR_OK" });
  });

  it("keeps documented in-progress states pending and undocumented states uncertain", async () => {
    for (const [state, expected] of [
      ["TRACKER_STARTED", "PENDING"], ["TRACKER_AUTHORIZED", "PENDING"],
      ["TRACKER_ENROLLED", "PENDING"], ["SOMETHING_NEW", "UNCERTAIN"],
    ] as const) {
      const result = await fetch(state);
      if (result.kind !== "authenticated") throw new Error(`rejected: ${state}`);
      expect((result.observation as Record<string, unknown>).kind, state).toBe(expected);
    }
  });

  it("rejects provider-reported amounts that contradict the expected attempt amount", async () => {
    expect((await fetch("TRACKER_ENDED", reporterBody("TRACKER_ENDED", "sandbox", 100001))).kind).toBe("rejected");
  });

  it("rejects an ok:false response, foreign environments and unparsable bodies", async () => {
    expect((await fetch("TRACKER_ENDED", reporterBody("TRACKER_ENDED", "sandbox", 100000, "PKR", false))).kind).toBe("rejected");
    expect((await fetch("TRACKER_ENDED", reporterBody("TRACKER_ENDED", "production"))).kind).toBe("rejected");
    expect((await fetch("TRACKER_ENDED", "nope")).kind).toBe("rejected");
  });

  it("derives a stable observation id per tracker/state/amount and a distinct one across states", async () => {
    const a = await fetch("TRACKER_ENDED"), b = await fetch("TRACKER_ENDED"), c = await fetch("TRACKER_STARTED");
    if (a.kind !== "authenticated" || b.kind !== "authenticated" || c.kind !== "authenticated") throw new Error("unreachable");
    expect((a.observation as Record<string, unknown>).observationId)
      .toBe((b.observation as Record<string, unknown>).observationId);
    expect((a.observation as Record<string, unknown>).observationId)
      .not.toBe((c.observation as Record<string, unknown>).observationId);
  });

  it("never fabricates timestamps", async () => {
    const result = await fetch("TRACKER_ENDED");
    if (result.kind !== "authenticated") throw new Error("unreachable");
    expect((result.observation as Record<string, unknown>).occurredAt).toBeNull();
  });
});
