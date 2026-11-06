import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PAYMENT_PROVIDER_VERIFICATION_ENABLED, approvedPaymentVerifier } from "@/lib/payments/verification-registry";
import { authenticatePaymentEvidence, copyVerificationInput, readTrustedPaymentEvidence } from "@/lib/payments/verified-evidence";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { sha256, type VerificationInput } from "@/lib/payments/evidence-contract";
import { createPaymentSettlementService, type PaymentPersistence } from "@/services/payment-settlement.service";
import { POST as webhook } from "@/app/api/webhooks/safepay/route";
import { POST as checkout } from "@/app/api/checkout/safepay/session/route";

const input: VerificationInput = { provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
  channel: "WEBHOOK", body: Buffer.from('{"synthetic":"success","verified":true}'), headers: {} };
const binding = { provider: input.provider, environment: input.environment, merchantAccountRef: input.merchantAccountRef,
  dedupKey: "a".repeat(64), firstPayloadSha256: sha256(input.body) };

describe("Production payment verification hard gates (no mocked registry)", () => {
  it.each(["WEBHOOK", "RECONCILIATION"] as const)("keeps %s verification disabled", async channel => {
    expect(PAYMENT_PROVIDER_VERIFICATION_ENABLED).toBe(false);
    expect(approvedPaymentVerifier({ ...input, channel })).toBeNull();
    expect(await authenticatePaymentEvidence({ ...input, channel })).toEqual({ kind: "blocked", code: "VERIFICATION_DISABLED" });
  });
  it("never reaches persistence for untrusted evidence", async () => {
    const neverDatabase = { $transaction: () => { throw new Error("Persistence must not be reached"); } } as unknown as PaymentPersistence;
    const service = createPaymentSettlementService(neverDatabase, { reconcileDelayMs: 1000 });
    expect(await service.apply({ verified: true, status: "PAID" }, "synthetic-event")).toEqual({ kind: "blocked", code: "UNTRUSTED_EVIDENCE" });
    expect(readTrustedPaymentEvidence({ verified: true }, new Date())).toBeNull();
  });
  it.each([
    ["webhook", webhook, 503],
    ["checkout", checkout, 422],
  ] as const)("keeps %s safely gated before payment work", async (name, handler, expectedStatus) => {
    const request = new Request("http://localhost/api/checkout/safepay/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const response = await handler(request); expect(response.status).toBe(expectedStatus);
    if (name === "webhook") {
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect((await response.json()).enabled).toBe(false);
    }
  });
  it.each([
    { channel: "BROWSER_CALLBACK" }, { body: new Uint8Array() }, { body: new Uint8Array(1_048_577) },
    { headers: { "x-test": "invalid\r\nheader" } }, { headers: { "X-Test": "one", "x-test": "two" } },
    { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ["x-" + i, "v"])) },
    { provider: undefined }, { headers: "invalid" },
  ])("rejects invalid verification input before registry dispatch", async override => {
    expect(await authenticatePaymentEvidence({ ...input, ...override } as VerificationInput)).toEqual({ kind: "blocked", code: "INVALID_INPUT" });
  });
  it("copies original bytes and headers instead of trusting mutable request buffers", () => {
    const body = Buffer.from("synthetic"), headers = { "x-example": "before" };
    const safe = copyVerificationInput({ ...input, body, headers }); body.fill(0); headers["x-example"] = "after";
    expect(new TextDecoder().decode(safe.body)).toBe("synthetic"); expect(safe.headers["x-example"]).toBe("before");
  });
});

describe("Encrypted payment inbox payload custody", () => {
  it("encrypts original bytes with authenticated scope and a rotatable key ring", () => {
    const oldKey = randomBytes(32), newKey = randomBytes(32);
    const oldVault = createPaymentPayloadVault("old", new Map([["old", oldKey]]));
    const sealed = oldVault.seal(input, binding);
    const rotated = createPaymentPayloadVault("new", new Map([["old", oldKey], ["new", newKey]]));
    expect(rotated.open(sealed, binding).body).toEqual(Uint8Array.from(input.body));
    expect(rotated.seal(input, binding).payloadKeyId).toBe("new");
    expect(JSON.stringify(rotated)).toBe('{"configured":true}');
    oldKey.fill(0); // Caller mutation cannot alter the vault's copied key material.
    expect(oldVault.open(sealed, binding).body).toEqual(Uint8Array.from(input.body));
  });
  it.each(["tag", "nonce", "ciphertext", "merchant", "digest", "key"])("rejects modified encrypted binding: %s", field => {
    const vault = createPaymentPayloadVault("test", new Map([["test", randomBytes(32)]]));
    const sealed = vault.seal(input, binding);
    const encrypted = { ...sealed, ...(field === "tag" ? { payloadAuthTag: randomBytes(16) } :
      field === "nonce" ? { payloadNonce: randomBytes(12) } : field === "ciphertext" ? { payloadCiphertext: randomBytes(12) } :
      field === "key" ? { payloadKeyId: "unknown" } : {}) };
    const context = { ...binding, ...(field === "merchant" ? { merchantAccountRef: "other" } : field === "digest" ? { firstPayloadSha256: "b".repeat(64) } : {}) };
    expect(() => vault.open(encrypted, context)).toThrow("could not be authenticated");
  });
  it("fails closed with missing or malformed encryption keys", () => {
    expect(() => createPaymentPayloadVault("missing", new Map())).toThrow();
    expect(() => createPaymentPayloadVault("test", new Map([["test", randomBytes(31)]]))).toThrow();
  });
});
