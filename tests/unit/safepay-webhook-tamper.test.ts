import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSafepayWebhookAdapter } from "../../src/lib/safepay/verification";

const secret = "local-test-secret-not-production-12345";
const tracker = "TEST_TAMPER_TRACKER";

const config = {
  environment: "sandbox",
  merchantAccountRef: "local-test-merchant",
  merchantApiKey: () => "local-test-key",
} as unknown as Parameters<typeof createSafepayWebhookAdapter>[0];

const adapter = createSafepayWebhookAdapter(
  config,
  secret,
  async (token) =>
    token === tracker
      ? {
          orderId: "test-order",
          paymentId: "test-payment",
          attemptNumber: 1,
          currency: "PKR",
          expectedAmountMinor: "799900",
          owner: null as never,
        }
      : null,
);

const originalBody = JSON.stringify({
  type: "payment.succeeded",
  token: "test-event-001",
  data: {
    tracker,
    state: "TRACKER_ENDED",
    amount: 799900,
    currency: "PKR",
    note: "original",
  },
});

const signature = createHmac("sha512", secret)
  .update(originalBody)
  .digest("hex");

function verificationInput(body: string) {
  return {
    provider: "SAFEPAY" as const,
    environment: "sandbox" as const,
    merchantAccountRef: "local-test-merchant",
    channel: "WEBHOOK" as const,
    body: new TextEncoder().encode(body),
    headers: {
      "x-sfpy-signature": signature,
    },
  };
}

describe("Safepay webhook body tampering", () => {
  it("accepts a valid, unchanged signed webhook", async () => {
    const result = await adapter.verify(
      verificationInput(originalBody),
    );

    expect(result.kind).toBe("authenticated");

    if (result.kind === "authenticated") {
      expect(result).toMatchObject({ kind: "authenticated", observation: { kind: "CAPTURE_CONFIRMED" } });
    }
  });

  it("rejects a modified note using the original signature", async () => {
    const modifiedBody = originalBody.replace(
      '"note":"original"',
      '"note":"tampered"',
    );

    expect(modifiedBody).not.toBe(originalBody);

    const result = await adapter.verify(
      verificationInput(modifiedBody),
    );

    expect(result.kind).toBe("rejected");
  });

  it("rejects a modified payment amount", async () => {
    const modifiedBody = originalBody.replace(
      '"amount":799900',
      '"amount":799901',
    );

    expect(modifiedBody).not.toBe(originalBody);

    const result = await adapter.verify(
      verificationInput(modifiedBody),
    );

    expect(result.kind).toBe("rejected");
  });
});


