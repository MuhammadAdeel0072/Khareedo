import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { VerificationInput } from "@/lib/payments/evidence-contract";
import { copyVerificationInput } from "@/lib/payments/verified-evidence";

export type PayloadBinding = Readonly<{ provider: string; environment: string; merchantAccountRef: string;
  dedupKey: string; firstPayloadSha256: string }>;
export type EncryptedPaymentPayload = { payloadKeyId: string; payloadCiphertext: Uint8Array;
  payloadNonce: Uint8Array; payloadAuthTag: Uint8Array };
const aad = (b: PayloadBinding) => Buffer.from(JSON.stringify(["KHAREEDO_PAYMENT_PAYLOAD_V1",
  b.provider, b.environment, b.merchantAccountRef, b.dedupKey, b.firstPayloadSha256]));
const envelopeSchema = z.object({ version: z.literal(1), channel: z.enum(["WEBHOOK", "RECONCILIATION"]),
  body: z.string().max(1_398_104).regex(/^[A-Za-z0-9+/]*={0,2}$/), headers: z.record(z.string(), z.string()) }).strict();

/** Key ring is injected by a future server composition root; no environment loading or DB construction. */
export function createPaymentPayloadVault(activeKeyId: string, keyRing: ReadonlyMap<string, Uint8Array>) {
  const keys = new Map<string, Buffer>();
  for (const [id, key] of keyRing) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || key.byteLength !== 32) throw new Error("Invalid payment payload key ring.");
    keys.set(id, Buffer.from(key));
  }
  if (!keys.has(activeKeyId)) throw new Error("Missing active payment payload key.");
  return Object.freeze({
    seal(input: VerificationInput, binding: PayloadBinding): EncryptedPaymentPayload {
      const safe = copyVerificationInput(input);
      const plaintext = Buffer.from(JSON.stringify({ version: 1, channel: safe.channel,
        body: Buffer.from(safe.body).toString("base64"), headers: safe.headers }));
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keys.get(activeKeyId)!, nonce);
      cipher.setAAD(aad(binding));
      return { payloadKeyId: activeKeyId, payloadCiphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
        payloadNonce: nonce, payloadAuthTag: cipher.getAuthTag() };
    },
    open(encrypted: EncryptedPaymentPayload, binding: PayloadBinding): VerificationInput {
      try {
        const key = keys.get(encrypted.payloadKeyId);
        if (!key || encrypted.payloadNonce.byteLength !== 12 || encrypted.payloadAuthTag.byteLength !== 16 ||
            encrypted.payloadCiphertext.byteLength > 1_700_000) throw new Error("Invalid encrypted payload.");
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.payloadNonce);
        decipher.setAAD(aad(binding)); decipher.setAuthTag(Buffer.from(encrypted.payloadAuthTag));
        const bytes = Buffer.concat([decipher.update(encrypted.payloadCiphertext), decipher.final()]);
        const data = envelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        const body = Buffer.from(data.body, "base64");
        if (body.toString("base64") !== data.body) throw new Error("Noncanonical body encoding.");
        return copyVerificationInput({ provider: binding.provider, environment: binding.environment as "sandbox" | "production",
          merchantAccountRef: binding.merchantAccountRef, channel: data.channel, body, headers: data.headers });
      } catch { throw new Error("Payment payload could not be authenticated or decrypted."); }
    },
    toJSON: () => ({ configured: true }),
  });
}
export type PaymentPayloadVault = ReturnType<typeof createPaymentPayloadVault>;
