import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SafepayConfig } from "./config";
import type {
  PaymentObservation,
  PaymentVerificationAdapter,
  VerificationInput,
} from "@/lib/payments/evidence-contract";

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Contract sources (verified 2026-11-09 against the official Safepay card-payment
// documentation, source: github.com/getsafepay/safepay-docs, site:
// safepay-docs.netlify.app â€” the generation this merchant's hosted checkout uses):
//
// - Webhook authenticity â€” developers/webhooks/verify-hmac-signatures:
//   X-SFPY-SIGNATURE carries HMAC-SHA512 over the raw request body bytes as a hex
//   digest ("crypto.createHmac("sha512", secret).update(data).digest("hex")"), keyed
//   by the endpoint shared secret from Dashboard > Developers > Endpoints. This
//   generation documents NO signed delivery-timestamp header, so timestamp freshness
//   is deliberately NOT enforced: the documented retry model redelivers queued events
//   (old created_at), and no tolerance is documented. Replay resistance comes from the
//   signature plus durable event-id dedup in the inbox.
// - Webhook events â€” developers/webhooks/webhook-types: envelope {type, version,
//   token, merchant_api_key, endpoint, data, created_at, delivery_attempts,
//   next_attempt_at}. payment.succeeded is "fired when a payment is captured" and its
//   data carries data.tracker as a tracker-token STRING with state/amount/currency as
//   sibling fields (example: state "TRACKER_ENDED", amount 45000, currency "PKR",
//   charged_at {seconds,nanos}). payment.failed is "fired when an error occurs" and
//   its documented data carries tracker/intent/state/customer_email/metadata/
//   category/code/message/failed_at â€” NO amount or currency fields; the official
//   example state is "TRACKER_ENROLLED" (a pre-authorization state). Docs explicitly
//   instruct accepting event types and state values beyond the documented list.
// - Tracker states â€” concepts/tracker-states: TRACKER_STARTED, TRACKER_AUTHORIZED,
//   TRACKER_ENROLLED, TRACKER_ENDED ("The tracker has been paid."), TRACKER_CANCELLED,
//   TRACKER_EXPIRED, TRACKER_REFUNDED, TRACKER_PARTIAL_REFUND, TRACKER_DISPUTED,
//   TRACKER_REVERSED, TRACKER_VOIDED. TRACKER_ENDED is the ONLY documented paid state
//   and NO state is documented as payment-failure finality. Failure classification is
//   therefore conservative: a payment.failed webhook never yields FAILURE_CONFIRMED
//   (explicit merchant-support blocker, see docs/SAFEPAY-SERVER-INTEGRATION.md).
// - Status lookup â€” concepts/fetch-tracker: GET /reporter/api/v1/payments/{tracker};
//   the documented response is {ok: true, data: {token, environment, state, intent,
//   mode, entry_mode, ..., purchase_totals: {quote_amount: {currency, amount}}}} â€”
//   the tracker fields sit DIRECTLY under data (no "tracker" wrapper, no status.errors).
//
// The newer Raastwire platform generation (safepay.mintlify.app: HMAC-SHA256 over
// "timestamp.body", five X-SFPY-* headers, aggregator event envelopes) is NOT this
// merchant's hosted-checkout contract and is deliberately not implemented: any event
// that does not match the documented card-payment shapes is quarantined for manual
// review, never processed, and never invents semantics.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  /** Locally expected amount in PKR minor units (paisa), as an exact decimal string. */
  expectedAmountMinor: string;
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
  /** Provider-reported amount, or null when the documented payload carries none. */
  amountMinor: string | null;
  capturedMinor: string | null;
  refundMinor: string | null;
  occurredAt: string | null;
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
    occurredAt: input.occurredAt,
  };
}

// Documented tracker state vocabulary (concepts/tracker-states). States whose documented
// interpretation is still "payment actions may run" are non-final-pending; everything
// else unlisted stays uncertain: guessing a failure could release reservations, guessing
// success could settle nothing.
const NON_FINAL_TRACKER_STATES: ReadonlySet<string> = new Set([
  "TRACKER_STARTED", "TRACKER_AUTHORIZED", "TRACKER_ENROLLED",
]);

// Webhook classification (developers/webhooks/webhook-types + concepts/tracker-states).
// - payment.succeeded is documented as "fired when a payment is captured", but capture
//   finality additionally requires the one documented paid state TRACKER_ENDED. A
//   missing, unknown or non-final state never becomes capture confirmation â€” it goes to
//   manual review instead of guessing.
// - payment.failed has NO documented failure-final state (the official example itself
//   carries TRACKER_ENROLLED), so a failed event NEVER becomes FAILURE_CONFIRMED here:
//   contradiction with the paid state goes to review, everything else stays UNCERTAIN.
function classifyWebhookObservation(
  eventType: "payment.succeeded" | "payment.failed",
  state: string | undefined,
): PaymentObservation["kind"] {
  const captured = state === "TRACKER_ENDED";
  if (eventType === "payment.succeeded") return captured ? "CAPTURE_CONFIRMED" : "REVIEW_REQUIRED";
  return captured ? "REVIEW_REQUIRED" : "UNCERTAIN";
}

// Reconciliation classification from the same documented vocabulary: only TRACKER_ENDED
// is paid; documented in-progress states stay pending; all other values stay uncertain.
function classifyTrackerState(state: string): PaymentObservation["kind"] {
  if (state === "TRACKER_ENDED") return "CAPTURE_CONFIRMED";
  if (NON_FINAL_TRACKER_STATES.has(state)) return "PENDING";
  return "UNCERTAIN";
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Webhook channel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Documented {seconds, nanos} protobuf timestamp used across webhook payloads.
const protobufTimestampSchema = z.object({
  seconds: z.number().int().safe(),
  nanos: z.number().int().min(0).max(999_999_999),
}).passthrough();

// Returns undefined when the field is absent (tolerated), null when present but
// malformed (caller rejects the undocumented shape), or a bounded ISO-8601 string.
// Bounded to 2001-09..2100-01 so Date arithmetic stays in the safe integer range.
function documentedTimestamp(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const parsed = protobufTimestampSchema.safeParse(value);
  if (!parsed.success) return null;
  const { seconds, nanos } = parsed.data;
  if (seconds <= 1_000_000_000 || seconds >= 4_102_444_800) return null;
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

// Documented webhook envelope (developers/webhooks/webhook-types). type and data are
// the only universally-present fields; the rest are validated whenever they appear.
const webhookEventSchema = z.object({
  type: z.string().min(1).max(128),
  data: z.unknown(),
  token: printableToken.max(256).optional(),
  version: z.literal("2.0.0").optional(),
  merchant_api_key: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).optional(),
  created_at: protobufTimestampSchema.optional(),
  delivery_attempts: z.number().int().min(0).max(1_000_000).optional(),
  next_attempt_at: protobufTimestampSchema.optional(),
}).passthrough();

// Documented payment-event data: data.tracker is a tracker-token STRING and
// state/amount/currency are sibling fields. amount/currency only exist on the
// documented payment.succeeded shape and are enforced per event type. The tracker
// OBJECT form belongs to the Fetch Tracker response, not to webhook payloads, and is
// deliberately not accepted here.
const webhookPaymentDataSchema = z.object({
  tracker: printableToken,
  state: z.string().min(1).max(128).optional(),
  intent: z.string().min(1).max(64).optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  charged_at: protobufTimestampSchema.optional(),
  failed_at: protobufTimestampSchema.optional(),
  refund_amount: z.number().optional(),
  balance: z.number().optional(),
  refunded_at: protobufTimestampSchema.optional(),
  reversed_authorization_id: printableToken.optional(),
  reversed_at: protobufTimestampSchema.optional(),
  void_type: z.string().min(1).max(128).optional(),
  voided_charge_id: printableToken.optional(),
  voided_at: protobufTimestampSchema.optional(),
}).passthrough();

function signatureHeader(value: string | undefined): string | null {
  if (!value || value.length < 32 || value.length > 256) return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]+$/.test(normalized) ? normalized : null;
}

function dataField(data: unknown, key: string): unknown {
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

// The envelope token is authenticated by the body signature. The delivery header is
// not, so when the token is absent use the signed body digest for replay identity.
function webhookObservationId(event: z.infer<typeof webhookEventSchema>, body: Uint8Array): string {
  if (event.token) return event.token;
  return createHash("sha256").update(Buffer.from(body)).digest("hex");
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
      if (!["payment.succeeded", "payment.failed", "payment.refunded", "authorization.reversed", "void.succeeded"].includes(event.type)) {
        return { kind: "rejected" as const };
      }
      // Documented account binding: a foreign merchant_api_key is not evidence about
      // this account. Absence is tolerated â€” the endpoint signature and the local
      // tracker binding already anchor the event to the configured account.
      if (event.merchant_api_key !== undefined && event.merchant_api_key !== config.merchantApiKey()) {
        return { kind: "rejected" as const };
      }
      if (documentedTimestamp(event.created_at) === null) return { kind: "rejected" as const };
      const data = webhookPaymentDataSchema.safeParse(event.data);
      if (!data.success) return { kind: "rejected" as const };
      // Provider-reported environment must be the configured one; anything else is not
      // evidence about this account and belongs in manual review.
      const dataEnvironment = dataField(event.data, "environment");
      if (dataEnvironment !== undefined && dataEnvironment !== config.environment) {
        return { kind: "rejected" as const };
      }
      const attempt = await resolveAttempt(resolveTracker, data.data.tracker);
      if (!attempt) return { kind: "rejected" as const };
      // Financial validation against the locally resolved attempt. For the documented
      // payment.succeeded shape, amount and currency are mandatory: a missing, invalid
      // or contradictory amount is rejected â€” the local expected amount is NEVER
      // substituted for a missing provider-reported amount. payment.failed has no
      // documented financial fields, so none are invented or recorded.
      let amountMinor: string | null = null;
      let refundMinor: string | null = null;
      let kind: PaymentObservation["kind"];
      let occurredAt: string | null = null;

      if (event.type === "payment.succeeded") {
        const parsed = minorFromAmount(data.data.amount ?? Number.NaN);

        if (
          parsed === null ||
          data.data.currency !== "PKR" ||
          attempt.currency !== "PKR" ||
          BigInt(parsed) !== BigInt(attempt.expectedAmountMinor)
        ) {
          return { kind: "rejected" as const };
        }

        amountMinor = parsed;
        kind = classifyWebhookObservation(
          "payment.succeeded",
          data.data.state
        );

        const timestamp = documentedTimestamp(data.data.charged_at);
        if (timestamp === null) return { kind: "rejected" as const };
        occurredAt = timestamp ?? null;

      } else if (event.type === "payment.failed") {
        kind = classifyWebhookObservation(
          "payment.failed",
          data.data.state
        );

        const timestamp = documentedTimestamp(data.data.failed_at);
        if (timestamp === null) return { kind: "rejected" as const };
        occurredAt = timestamp ?? null;

      } else if (event.type === "payment.refunded") {
        const refund = minorFromAmount(
          data.data.refund_amount ?? Number.NaN
        );

        if (
          refund === null ||
          data.data.currency !== "PKR" ||
          attempt.currency !== "PKR" ||
          BigInt(refund) > BigInt(attempt.expectedAmountMinor) ||
          data.data.balance === undefined ||
          !Number.isSafeInteger(data.data.balance) ||
          data.data.balance < 0
        ) {
          return { kind: "rejected" as const };
        }

        const timestamp = documentedTimestamp(data.data.refunded_at);
        if (!timestamp) return { kind: "rejected" as const };

        refundMinor = refund;
        occurredAt = timestamp;

        kind = [
          "TRACKER_REFUNDED",
          "TRACKER_PARTIAL_REFUND",
        ].includes(data.data.state ?? "")
          ? "REFUND_NOTICE"
          : "REVIEW_REQUIRED";

      } else if (event.type === "authorization.reversed") {
        if (
          data.data.state !== "TRACKER_REVERSED" ||
          !data.data.reversed_authorization_id
        ) {
          return { kind: "rejected" as const };
        }

        const timestamp = documentedTimestamp(data.data.reversed_at);
        if (!timestamp) return { kind: "rejected" as const };

        kind = "REVIEW_REQUIRED";
        occurredAt = timestamp;

      } else if (event.type === "void.succeeded") {
        if (
          data.data.state !== "TRACKER_VOIDED" ||
          !data.data.void_type
        ) {
          return { kind: "rejected" as const };
        }

        const timestamp = documentedTimestamp(data.data.voided_at);
        if (!timestamp) return { kind: "rejected" as const };

        kind = "REVIEW_REQUIRED";
        occurredAt = timestamp;

      } else {
        return { kind: "rejected" as const };
      }

      const capture = kind === "CAPTURE_CONFIRMED";

      return {
        kind: "authenticated" as const,
        observation: observation({
          config, merchantIdentity, attempt,
          trackerToken: data.data.tracker,
          observationId: webhookObservationId(event, input.body),
          kind,
          amountMinor,
          capturedMinor: capture ? amountMinor : null,
          refundMinor: capture ? "0" : refundMinor,
          occurredAt,
        }),
      };
    },
  });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Reconciliation channel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Documented Fetch Tracker response (concepts/fetch-tracker): the tracker object sits
// DIRECTLY under `data` â€” token/environment/state/purchase_totals are its own fields.
const reporterResponseSchema = z.object({
  ok: z.literal(true).optional(),
  data: z.object({
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
      const tracker = parsed.data;
      if (tracker.environment !== config.environment) return { kind: "rejected" as const };
      const attempt = await resolveAttempt(resolveTracker, tracker.token);
      if (!attempt) return { kind: "rejected" as const };
      const quote = tracker.purchase_totals.quote_amount;
      const amountMinor = minorFromAmount(quote.amount);
      if (amountMinor === null || quote.currency !== "PKR" || attempt.currency !== "PKR") {
        return { kind: "rejected" as const };
      }
      // Provider-reported amount must equal the locally expected attempt amount.
      if (BigInt(amountMinor) !== BigInt(attempt.expectedAmountMinor)) {
        return { kind: "rejected" as const };
      }
      const kind = classifyTrackerState(tracker.state);
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
          // The documented response fields consumed here carry no per-action timestamp;
          // none is ever fabricated.
          occurredAt: null,
        }),
      };
    },
  });
}


