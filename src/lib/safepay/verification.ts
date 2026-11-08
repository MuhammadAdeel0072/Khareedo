import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SafepayConfig } from "./config";
import type {
  PaymentObservation,
  PaymentVerificationAdapter,
  VerificationInput,
} from "@/lib/payments/evidence-contract";

// ─────────────────────────────────────────────────────────────────────────────
// Contract sources (verified against official Safepay documentation):
// - Webhook verification: https://safepay-docs.netlify.app/developers/webhooks/
//   verify-hmac-signatures — HMAC-SHA512 over the raw request body bytes, hex digest,
//   delivered in the X-SFPY-SIGNATURE header, keyed by the dashboard "Endpoints"
//   shared secret. The official PHP SDK (getsafepay/sfpy-php Webhook::constructEvent)
//   implements the same contract for the hosted-payments generation.
// - Webhook events: X-SFPY-SIGNATURE + JSON body with a `type` ("payment.succeeded",
//   "payment.failed", ...) and a `data` payment object. Only documented types are
//   classified; every other shape is REJECTED into the review quarantine.
// - Tracker status: https://safepay-docs.netlify.app/build-your-integration/
//   express-checkout/ — GET /reporter/api/v1/payments/{tracker} with
//   X-SFPY-MERCHANT-SECRET. Success is only ever derived from tracker state
//   TRACKER_ENDED ("Confirm checkout success only when the tracker state becomes
//   TRACKER_ENDED" — official guidance). All other states stay non-final.
//
// A newer Safepay platform generation documents a different webhook contract
// (HMAC-SHA256 over "timestamp.body", five X-SFPY-* headers). That generation is
// NOT implemented here: an unrecognized event or signature profile is quarantined
// for manual review, never processed, and never invents semantics.
// ─────────────────────────────────────────────────────────────────────────────

export const SAFEPAY_EVIDENCE_CONTRACT_VERSION = "SAFEPAY-HOSTED-V1";

const MAX_TRACKER_LENGTH = 2048;
const printableToken = z.string().min(1).max(MAX_TRACKER_LENGTH).regex(/^[\x21-\x7e]+$/);

function merchantIdentityFromSecret(purpose: string, secret: string): string {
  // Local credential-derived account binding. Recorded in evidence, never reveals the
  // secret; rotates with the secret so stale-key evidence cannot outlive rotation.
  return createHash("sha256").update(JSON.stringify(["KHAREEDO_SFPY_MERCHANT_IDENTITY_V1", purpose, secret])).digest("hex");
}

function stableObservationId(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(["SAFEPAY_OBSERVATION_V1", ...parts])).digest("hex");
}

function minorFromAmount(amount: number): string | null {
  return Number.isSafeInteger(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER ? String(amount) : null;
}

// Local attempt identity bound to a tracker. The adapter is pure (no DB import);
// the registry injects this resolver so adapter tests stay storage-free.
export type SafepayAttemptContext = Readonly<{
  orderId: string;
  paymentId: string;
  attemptNumber: number;
  currency: string;
  owner: PaymentObservation["owner"];
}>;
export type SafepayTrackerResolver = (
  trackerToken: string,
) => Promise<SafepayAttemptContext | null>;

async function resolveAttempt(
  resolver: SafepayTrackerResolver,
  trackerToken: string,
): Promise<SafepayAttemptContext | null> {
  if (!printableToken.safeParse(trackerToken).success) return null;
  try {
    return await resolver(trackerToken);
  } catch {
    return null;
  }
}

function observation(input: {
  config: SafepayConfig;
  merchantIdentity: string;
  attempt: SafepayAttemptContext;
  trackerToken: string;
  observationId: string;
  kind: PaymentObservation["kind"];
  amountMinor: string;
  capturedMinor: string | null;
  refundMinor: string | null;
}): PaymentObservation {
  return {
    provider: "SAFEPAY",
    environment: input.config.environment,
    merchantAccountRef: input.config.merchantAccountRef,
    merchantIdentity: input.merchantIdentity,
    observationId: input.observationId,
    orderId: input.attempt.orderId,
    paymentId: input.attempt.paymentId,
    attemptNumber: input.attempt.attemptNumber,
    trackerToken: input.trackerToken,
    owner: input.attempt.owner,
    currency: input.attempt.currency,
    amountMinor: input.amountMinor,
    kind: input.kind,
    capturedMinor: input.capturedMinor,
    refundMinor: input.refundMinor,
    occurredAt: null, // No documented provider timestamp on either channel; never fabricated.
  };
}

// Finality is derived ONLY from documented states. Anything unlisted stays uncertain:
// guessing a failure could release reservations; guessing success could settle nothing.
function classifyTrackerState(state: string | undefined): PaymentObservation["kind"] | "UNPARSABLE" {
  if (state === undefined) return "UNPARSABLE";
  if (state === "TRACKER_ENDED") return "CAPTURE_CONFIRMED";
  if (state === "TRACKER_STARTED") return "PENDING";
  return "UNCERTAIN";
}

// ─────────────────────────── Webhook channel ───────────────────────────

const webhookEventSchema = z.object({
  type: z.string().min(1).max(128),
  data: z.unknown(),
}).passthrough();

const webhookTrackerObjectSchema = z.object({
  token: printableToken,
  state: z.string().min(1).max(128).optional(),
  purchase_totals: z.object({
    quote_amount: z.object({
      currency: z.string().regex(/^[A-Z]{3}$/),
      amount: z.number(),
    }).passthrough(),
  }).passthrough().optional(),
}).passthrough();

function signatureHeader(value: string | undefined): string | null {
  if (!value || value.length < 32 || value.length > 256) return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]+$/.test(normalized) ? normalized : null;
}

function trackerFactsFromData(data: unknown): {
  token: string; state?: string; amountMinor?: string; currency?: string;
} | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const tracker = (data as Record<string, unknown>)["tracker"];
  if (typeof tracker === "string") {
    return printableToken.safeParse(tracker).success ? { token: tracker } : null;
  }
  const parsed = webhookTrackerObjectSchema.safeParse(tracker);
  if (!parsed.success) return null;
  const quote = parsed.data.purchase_totals?.quote_amount;
  let amountMinor: string | undefined;
  if (quote) {
    const minor = minorFromAmount(quote.amount);
    if (minor === null) return null;
    amountMinor = minor;
  }
  return {
    token: parsed.data.token,
    ...(parsed.data.state !== undefined ? { state: parsed.data.state } : {}),
    ...(amountMinor !== undefined ? { amountMinor } : {}),
    ...(quote ? { currency: quote.currency } : {}),
  };
}

export function createSafepayWebhookAdapter(
  config: SafepayConfig,
  webhookSecret: string,
  resolveTracker: SafepayTrackerResolver,
): PaymentVerificationAdapter {
  const merchantIdentity = merchantIdentityFromSecret("WEBHOOK", webhookSecret);
  return Object.freeze({
    provider: "SAFEPAY",
    channel: "WEBHOOK",
    contractVersion: SAFEPAY_EVIDENCE_CONTRACT_VERSION,
    merchantAccountRef: config.merchantAccountRef,
    environment: config.environment,
    merchantIdentity,
    // Documented authentication/delivery headers across Safepay webhook generations.
    // Signature is the verification header; the others are retained review metadata.
    retainedHeaderNames: Object.freeze([
      "x-sfpy-signature", "x-sfpy-event-id", "x-sfpy-timestamp", "x-sfpy-event-type",
    ]) as readonly string[],
    async verify(input: VerificationInput) {
      // 1. Authenticate the exact received bytes against the documented HMAC-SHA512/hex contract.
      const received = signatureHeader(input.headers["x-sfpy-signature"]);
      if (!received) return { kind: "rejected" as const };
      const expected = createHmac("sha512", webhookSecret).update(Buffer.from(input.body)).digest("hex");
      const receivedBytes = Buffer.from(received, "hex");
      if (receivedBytes.length !== 64 || !timingSafeEqual(receivedBytes, Buffer.from(expected, "hex"))) {
        return { kind: "rejected" as const };
      }
      // 2. Parse the documented envelope. Unrecognized shapes stay quarantined, never classified.
      let event: z.infer<typeof webhookEventSchema>;
      try {
        event = webhookEventSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body)));
      } catch {
        return { kind: "rejected" as const };
      }
      if (event.type !== "payment.succeeded" && event.type !== "payment.failed") {
        return { kind: "rejected" as const };
      }
      const facts = trackerFactsFromData(event.data);
      if (!facts) return { kind: "rejected" as const };
      const attempt = await resolveAttempt(resolveTracker, facts.token);
      if (!attempt) return { kind: "rejected" as const };
      // Provider-reported environment must be the configured one; anything else is not
      // evidence about this account and belongs in manual review.
      const dataEnvironment = (event.data as Record<string, unknown> | null) &&
        typeof event.data === "object" && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)["environment"]
        : undefined;
      if (dataEnvironment !== undefined && dataEnvironment !== config.environment) {
        return { kind: "rejected" as const };
      }
      const currency = facts.currency ?? attempt.currency;
      if (!facts.amountMinor || currency !== "PKR" || attempt.currency !== "PKR") {
        return { kind: "rejected" as const };
      }
      const classified = classifyTrackerState(facts.state);
      // The documented event type is the primary signal ("payment.succeeded" → mark the
      // payment complete per the official webhook guide); tracker state is corroboration.
      // Contradictory evidence (succeeded while state still TRACKER_STARTED, failed while
      // TRACKER_ENDED) is never resolved by guessing — it goes to manual review.
      const kind: PaymentObservation["kind"] =
        event.type === "payment.failed"
          ? classified === "CAPTURE_CONFIRMED" ? "REVIEW_REQUIRED" : "FAILURE_CONFIRMED"
          : classified === "UNPARSABLE" || classified === "CAPTURE_CONFIRMED" ? "CAPTURE_CONFIRMED"
          : "REVIEW_REQUIRED";
      const capture = kind === "CAPTURE_CONFIRMED";
      // Event identity: documented X-SFPY event id when present, else the body digest —
      // stable for identical at-least-once redeliveries of the same signed payload.
      const headerEventId = input.headers["x-sfpy-event-id"];
      const observationId = headerEventId && /^[\x21-\x7e]{1,256}$/.test(headerEventId)
        ? headerEventId
        : createHash("sha256").update(Buffer.from(input.body)).digest("hex");
      return {
        kind: "authenticated" as const,
        observation: observation({
          config, merchantIdentity, attempt,
          trackerToken: facts.token,
          observationId,
          kind,
          amountMinor: facts.amountMinor,
          capturedMinor: capture ? facts.amountMinor : null,
          refundMinor: capture ? "0" : null,
        }),
      };
    },
  });
}

// ──────────────────────── Reconciliation channel ────────────────────────

const reporterResponseSchema = z.object({
  data: z.object({
    tracker: z.object({
      token: printableToken,
      environment: z.enum(["sandbox", "production"]),
      state: z.string().min(1).max(128),
      purchase_totals: z.object({
        quote_amount: z.object({
          currency: z.string().regex(/^[A-Z]{3}$/),
          amount: z.number(),
        }).passthrough(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
  status: z.object({ errors: z.array(z.unknown()) }).passthrough(),
}).passthrough();

export function createSafepayReconciliationAdapter(
  config: SafepayConfig,
  resolveTracker: SafepayTrackerResolver,
): PaymentVerificationAdapter {
  const merchantIdentity = merchantIdentityFromSecret("MERCHANT_SECRET", config.merchantApiKey());
  return Object.freeze({
    provider: "SAFEPAY",
    channel: "RECONCILIATION",
    contractVersion: SAFEPAY_EVIDENCE_CONTRACT_VERSION,
    merchantAccountRef: config.merchantAccountRef,
    environment: config.environment,
    merchantIdentity,
    retainedHeaderNames: Object.freeze([]) as readonly string[],
    async verify(input: VerificationInput) {
      // Server-initiated channel: the request was authenticated with the merchant secret
      // over TLS to the documented host; identity binds to that credential.
      let parsed: z.infer<typeof reporterResponseSchema>;
      try {
        parsed = reporterResponseSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body)));
      } catch {
        return { kind: "rejected" as const };
      }
      if (parsed.status.errors.length > 0) return { kind: "rejected" as const };
      const tracker = parsed.data.tracker;
      if (tracker.environment !== config.environment) return { kind: "rejected" as const };
      const attempt = await resolveAttempt(resolveTracker, tracker.token);
      if (!attempt) return { kind: "rejected" as const };
      const quote = tracker.purchase_totals.quote_amount;
      const amountMinor = minorFromAmount(quote.amount);
      if (!amountMinor || quote.currency !== "PKR" || attempt.currency !== "PKR") {
        return { kind: "rejected" as const };
      }
      const classified = classifyTrackerState(tracker.state);
      const kind: PaymentObservation["kind"] =
        classified === "UNPARSABLE" ? "UNCERTAIN" : classified;
      const capture = kind === "CAPTURE_CONFIRMED";
      // Stable for the same tracker/state/amount: repeated identical reconciliations dedup,
      // a genuine state transition produces a new observation.
      const observationId = stableObservationId(["REPORTER", tracker.token, tracker.state, amountMinor]);
      return {
        kind: "authenticated" as const,
        observation: observation({
          config, merchantIdentity, attempt,
          trackerToken: tracker.token,
          observationId,
          kind,
          amountMinor,
          capturedMinor: capture ? amountMinor : null,
          refundMinor: capture ? "0" : null,
        }),
      };
    },
  });
}
