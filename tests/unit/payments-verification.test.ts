import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAYMENT_PROVIDER_VERIFICATION_ENABLED, approvedPaymentVerifier } from "@/lib/payments/verification-registry";
import { authenticatePaymentEvidence, copyVerificationInput, readTrustedPaymentEvidence } from "@/lib/payments/verified-evidence";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { sha256, type VerificationInput } from "@/lib/payments/evidence-contract";
import { createPaymentSettlementService, type PaymentPersistence } from "@/services/payment-settlement.service";

vi.mock("@/lib/db", () => ({ db: { $transaction: vi.fn(), payment: { findFirst: vi.fn() } } }));

const sandboxEnv = {
  SAFEPAY_ENVIRONMENT: "sandbox",
  SAFEPAY_ENTRY_MODE: "flex",
  SAFEPAY_MERCHANT_API_KEY: "synthetic-public",
  SAFEPAY_SECRET_KEY: "synthetic-secret",
  SAFEPAY_RETURN_STATE_SECRET: "synthetic-independent-return-key-at-least-32-bytes",
  SAFEPAY_MERCHANT_ACCOUNT_REF: "synthetic-account",
  SAFEPAY_SITE_ORIGIN: "https://shop.example.invalid",
  SAFEPAY_WEBHOOK_SECRET: "synthetic-webhook-secret-0123456789abcdef",
};

const input: VerificationInput = { provider: "SAFEPAY", environment: "sandbox", merchantAccountRef: "synthetic-account",
  channel: "WEBHOOK", body: Buffer.from('{"synthetic":"success","verified":true}'), headers: {} };
const binding = { provider: input.provider, environment: input.environment, merchantAccountRef: input.merchantAccountRef,
  dedupKey: "a".repeat(64), firstPayloadSha256: sha256(input.body) };

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

afterEach(() => vi.restoreAllMocks());

describe("Sandbox-scoped payment verification gate", () => {
  it("enables sandbox evidence verification as a code-level fact", () => {
    expect(PAYMENT_PROVIDER_VERIFICATION_ENABLED).toBe(true);
  });

  it("approves sandbox Safepay adapters for both channels", () => {
    withEnv(sandboxEnv, () => {
      for (const channel of ["WEBHOOK", "RECONCILIATION"] as const) {
        const adapter = approvedPaymentVerifier({ ...input, channel });
        expect(adapter).not.toBeNull();
        expect(adapter!.provider).toBe("SAFEPAY");
        expect(adapter!.channel).toBe(channel);
        expect(adapter!.environment).toBe("sandbox");
        expect(adapter!.merchantAccountRef).toBe("synthetic-account");
        expect(adapter!.merchantIdentity).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  it.each([
    ["production environment", { environment: "production" } as const],
    ["foreign provider", { provider: "OTHERPAY" } as const],
    ["foreign merchant account", { merchantAccountRef: "other-account" } as const],
    ["unknown channel", { channel: "BROWSER_CALLBACK" } as const],
  ])("keeps verification disabled: %s", (_name, override) => {
    withEnv(sandboxEnv, () => {
      expect(approvedPaymentVerifier({ ...input, ...override } as VerificationInput)).toBeNull();
    });
  });

  it("stays closed without server configuration", () => {
    withEnv(Object.fromEntries(Object.keys(sandboxEnv).map(key => [key, undefined])), () => {
      expect(approvedPaymentVerifier(input)).toBeNull();
    });
  });

  it("stays closed without a webhook secret for the webhook channel", () => {
    withEnv({ ...sandboxEnv, SAFEPAY_WEBHOOK_SECRET: undefined }, () => {
      expect(approvedPaymentVerifier({ ...input, channel: "WEBHOOK" })).toBeNull();
      expect(approvedPaymentVerifier({ ...input, channel: "RECONCILIATION" })).not.toBeNull();
    });
  });

  it("blocks unauthenticated evidence end to end when the registry closes", async () => {
    const production = { ...input, environment: "production" as const };
    withEnv(sandboxEnv, () => {});
    expect(await authenticatePaymentEvidence(production)).toEqual({ kind: "blocked", code: "VERIFICATION_DISABLED" });
  });

  it("never reaches persistence for untrusted evidence", async () => {
    const neverDatabase = { $transaction: () => { throw new Error("Persistence must not be reached"); } } as unknown as PaymentPersistence;
    const service = createPaymentSettlementService(neverDatabase, { reconcileDelayMs: 1000 });
    expect(await service.apply({ verified: true, status: "PAID" }, "synthetic-event")).toEqual({ kind: "blocked", code: "UNTRUSTED_EVIDENCE" });
    expect(readTrustedPaymentEvidence({ verified: true }, new Date())).toBeNull();
  });

  it.each([
    { channel: "BROWSER_CALLBACK" }, { body: new Uint8Array() }, { body: new Uint8Array(1_048_577) },
    { headers: { "x-test": "invalid\r\nheader" } },
    { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ["x-" + i, "v"])) },
    { provider: undefined }, { headers: "invalid" },
  ] as Array<Partial<VerificationInput>>)("rejects invalid verification input before registry dispatch", async override => {
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
