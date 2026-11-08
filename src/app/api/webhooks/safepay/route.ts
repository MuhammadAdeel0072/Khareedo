import { loadSafepayConfig, loadSafepayWebhookSecret, SafepayConfigurationError } from "@/lib/safepay/config";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { loadPaymentPayloadVaultKeys } from "@/lib/payments/vault-env";
import { PAYMENT_PROVIDER_VERIFICATION_ENABLED } from "@/lib/payments/verification-registry";
import { db } from "@/lib/db";
import type { VerificationInput } from "@/lib/payments/evidence-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Documented Safepay webhook delivery contract: acknowledge within 10 seconds, store
// before acknowledging, and let transport errors/5xx enter the provider retry queue
// while terminal 4xx responses stop redelivery. Processing happens out of band via the
// admin maintenance trigger, never inside the delivery window.
const MAX_BODY_BYTES = 1_048_576;
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

function reply(status: number, payload: Record<string, unknown>, extraHeaders?: HeadersInit) {
  return Response.json(payload, { status, headers: { ...noStore, ...(extraHeaders ?? {}) } });
}

// Only documented Safepay delivery headers are bound into verification input; proxies
// may append arbitrary hops that would exceed the bounded input contract.
const retainedRequestHeaders = ["content-type", "user-agent", "x-sfpy-signature", "x-sfpy-event-id",
  "x-sfpy-timestamp", "x-sfpy-event-type", "x-sfpy-aggregator-id"] as const;

export async function POST(request: Request) {
  let config, webhookSecret: string;
  try {
    config = loadSafepayConfig();
    const secret = loadSafepayWebhookSecret();
    if (!secret) throw new SafepayConfigurationError();
    webhookSecret = secret;
  } catch (error) {
    if (!(error instanceof SafepayConfigurationError)) throw error;
    // Not configured yet: 503 keeps the events in Safepay's retry queue instead of
    // dropping signed deliveries on the floor.
    return reply(503, { ok: false, code: "SAFEPAY_WEBHOOK_NOT_CONFIGURED",
      enabled: PAYMENT_PROVIDER_VERIFICATION_ENABLED });
  }

  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && (/^\d+$/.test(lengthHeader) && Number(lengthHeader) > MAX_BODY_BYTES)) {
    return reply(413, { ok: false, code: "PAYLOAD_TOO_LARGE" });
  }
  let body: Uint8Array;
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength < 1 || buffer.byteLength > MAX_BODY_BYTES) {
      return reply(413, { ok: false, code: "PAYLOAD_TOO_LARGE" });
    }
    body = new Uint8Array(buffer);
  } catch {
    return reply(400, { ok: false, code: "INVALID_PAYLOAD" });
  }

  const headers: Record<string, string> = {};
  for (const name of retainedRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const input: VerificationInput = {
    provider: "SAFEPAY", environment: config.environment,
    merchantAccountRef: config.merchantAccountRef, channel: "WEBHOOK", body, headers,
  };

  const vaultKeys = loadPaymentPayloadVaultKeys();
  if (!vaultKeys) {
    // Custody for the signed bytes is mandatory before accepting a delivery.
    return reply(503, { ok: false, code: "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE",
      enabled: PAYMENT_PROVIDER_VERIFICATION_ENABLED });
  }
  const vault = createPaymentPayloadVault(vaultKeys.activeKeyId, vaultKeys.keyRing);
  const inbox = createPaymentWebhookService(db as unknown as Parameters<typeof createPaymentWebhookService>[0],
    vault, { reconcileDelayMs: 60_000 });

  let result;
  try {
    result = await inbox.receive(input);
  } catch {
    return reply(503, { ok: false, code: "PERSISTENCE_UNAVAILABLE" });
  }
  if (result.kind === "blocked") {
    // BUSY/PERSISTENCE_UNAVAILABLE → 503 so Safepay retries; INVALID_INPUT → terminal 400.
    return result.code === "INVALID_INPUT"
      ? reply(400, { ok: false, code: "INVALID_PAYLOAD" })
      : reply(503, { ok: false, code: result.code });
  }
  // stored | duplicate | quarantined | conflict: the signed bytes are durably in custody.
  // Acknowledge 200 even for quarantined/unrecognized events so the provider does not
  // redeliver payloads this system has deliberately parked for review.
  return reply(200, { ok: true, code: result.kind });
}
