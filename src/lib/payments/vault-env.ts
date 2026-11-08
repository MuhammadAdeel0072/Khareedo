import "server-only";
import type { createPaymentPayloadVault } from "@/lib/payments/payload-vault";

// Composition root for payment payload custody. The webhook inbox must be able to
// re-open the exact signed bytes before settlement, so a key must exist before any
// delivery is accepted. Nothing here derives keys from provider values or secrets.
type VaultKeys = {
  activeKeyId: string;
  keyRing: ReadonlyMap<string, Uint8Array>;
};

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function loadPaymentPayloadVaultKeys(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VaultKeys | null {
  const raw = env.PAYMENT_PAYLOAD_KEY;
  if (!raw || raw.length === 0 || raw.length > 4096 || /[^\x21-\x7e]/.test(raw)) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  if (key.byteLength !== 32) return null;
  const activeKeyId = env.PAYMENT_PAYLOAD_KEY_ID && KEY_ID_PATTERN.test(env.PAYMENT_PAYLOAD_KEY_ID)
    ? env.PAYMENT_PAYLOAD_KEY_ID
    : "primary";
  return { activeKeyId, keyRing: new Map([[activeKeyId, new Uint8Array(key)]]) };
}

export type PaymentPayloadVault = ReturnType<typeof createPaymentPayloadVault>;
