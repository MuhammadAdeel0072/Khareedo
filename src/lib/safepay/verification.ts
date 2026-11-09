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

// Non-negative variant for fields where zero is a legitimate documented value (e.g. a
// fully-refunded tracker reports balance 0).
function nonNegativeFromAmount(amount: number): string | null {
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER ? String(amount) : null;
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
  providerState: string | null;
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
    providerState: input.providerState,
    occurredAt: input.occurredAt,
  };
}

// Finality is derived ONLY from documented states. Anything unlisted stays uncertain:
// guessing a failure could release reservations; guessing success could settle nothing.
// Documented refund/reversal states are classified as their own intermediate facts:
// they are never capture facts and never finalize money by themselves — the refund
// settlement path corroborates them against the local ledger.
function classifyTrackerState(state: string | undefined):
  PaymentObservation["kind"] | "REFUND_FULL" | "REFUND_PARTIAL" | "REVERSED" | "UNPARSABLE" {
  if (state === undefined) return "UNPARSABLE";
  if (state === "TRACKER_ENDED") return "CAPTURE_CONFIRMED";
  if (state === "TRACKER_STARTED") return "PENDING";
  if (state === "TRACKER_REFUNDED") return "REFUND_FULL";
  if (state === "TRACKER_PARTIAL_REFUND") return "REFUND_PARTIAL";
  if (state === "TRACKER_REVERSED") return "REVERSED";
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

// Documented payment.refunded payload fields: refund_amount (this refund, integer minor
// units), optional balance (remaining refundable), optional refunded_at { seconds, nanos }.
// Absent or malformed refund amounts are REJECTED (quarantined) — an amount is never guessed.
function refundAmountFromData(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)["refund_amount"];
  return typeof value === "number" ? minorFromAmount(value) : null;
}

function refundBalanceFromData(data: unknown): string | null | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>)["balance"];
  if (value === undefined || value === null) return undefined;
  const minor = typeof value === "number" ? nonNegativeFromAmount(value) : null;
  return minor === null ? null : minor; // null = present but invalid
}

function refundedAtFromData(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)["refunded_at"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const seconds = (value as Record<string, unknown>)["seconds"];
  // Bounded epoch seconds (1970..2100). Nanos are documented but sub-second precision is
  // not representable in the observation timestamp; the second is the asserted fact.
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) ||
      seconds < 0 || seconds > 4_102_444_800) return null;
  return new Date(seconds * 1000).toISOString();
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
      const documentedEvent = event.type === "payment.succeeded" || event.type === "payment.failed" ||
        event.type === "payment.refunded" || event.type === "void.succeeded" ||
        event.type === "authorization.reversed";
      if (!documentedEvent) {
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
      if (currency !== "PKR" || attempt.currency !== "PKR") {
        return { kind: "rejected" as const };
      }
      const classified = classifyTrackerState(facts.state);
      // Event identity: documented X-SFPY event id when present, else the body digest —
      // stable for identical at-least-once redeliveries of the same signed payload.
      const headerEventId = input.headers["x-sfpy-event-id"];
      const observationId = headerEventId && /^[\x21-\x7e]{1,256}$/.test(headerEventId)
        ? headerEventId
        : createHash("sha256").update(Buffer.from(input.body)).digest("hex");
      const captureMinor = facts.amountMinor ?? null;

      // Documented refund event: an authenticated statement that this tracker refunded
      // refund_amount minor units. The amount is the settlement fact; the tracker state
      // (when present) is corroboration. A refund event whose state contradicts a refund
      // (capture/pending/reversed) is never resolved by guessing — it goes to review.
      if (event.type === "payment.refunded") {
        const refundMinor = refundAmountFromData(event.data);
        if (!refundMinor) return { kind: "rejected" as const };
        if (refundBalanceFromData(event.data) === null) return { kind: "rejected" as const };
        const contradictory = classified === "CAPTURE_CONFIRMED" || classified === "PENDING" ||
          classified === "REVERSED";
        // Contradictory refund events stay authenticated but carry the REFUND amount into
        // review: settlement routes them to manual handling with the asserted amount intact.
        const kind: PaymentObservation["kind"] = contradictory ? "REVIEW_REQUIRED" : "REFUND_CONFIRMED";
        return {
          kind: "authenticated" as const,
          observation: observation({
            config, merchantIdentity, attempt,
            trackerToken: facts.token,
            observationId,
            kind,
            // amountMinor is the original quote when the event carries totals; "0" is the
            // declared sentinel for "not asserted by this evidence" on refund events.
            amountMinor: captureMinor ?? "0",
            capturedMinor: null,
            refundMinor,
            providerState: facts.state ?? null,
            occurredAt: refundedAtFromData(event.data),
          }),
        };
      }

      // Documented reversal events (authorization/void generation). Khareedo never submits
      // reversals, so any reversal for a local tracker is a dashboard action: recorded and
      // routed to manual review. Reversals are never conflated with post-capture refunds.
      if (event.type === "void.succeeded" || event.type === "authorization.reversed") {
        return {
          kind: "authenticated" as const,
          observation: observation({
            config, merchantIdentity, attempt,
            trackerToken: facts.token,
            observationId,
            kind: "REVERSAL_NOTICE",
            amountMinor: captureMinor ?? "0",
            capturedMinor: null,
            refundMinor: null,
            providerState: facts.state ?? null,
            occurredAt: null,
          }),
        };
      }

      // The documented event type is the primary signal ("payment.succeeded" → mark the
      // payment complete per the official webhook guide); tracker state is corroboration.
      // Contradictory evidence (succeeded while state still TRACKER_STARTED or a
      // refund/reversal state, failed while TRACKER_ENDED) is never resolved by guessing —
      // it goes to manual review.
      const kind: PaymentObservation["kind"] =
        event.type === "payment.failed"
          ? classified === "UNCERTAIN" || classified === "UNPARSABLE" || classified === "PENDING"
            ? "FAILURE_CONFIRMED" : "REVIEW_REQUIRED"
          : classified === "UNPARSABLE" || classified === "CAPTURE_CONFIRMED" ? "CAPTURE_CONFIRMED"
          : "REVIEW_REQUIRED";
      const capture = kind === "CAPTURE_CONFIRMED";
      if (!captureMinor) return { kind: "rejected" as const };
      return {
        kind: "authenticated" as const,
        observation: observation({
          config, merchantIdentity, attempt,
          trackerToken: facts.token,
          observationId,
          kind,
          amountMinor: captureMinor,
          capturedMinor: capture ? captureMinor : null,
          refundMinor: capture ? "0" : null,
          providerState: facts.state ?? null,
          occurredAt: null,
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
      // Documented refund/reversal tracker states: recorded as authenticated observations
      // WITHOUT any refund amount (the reporter does not document one). Settlement decides
      // what may be finalized from these facts against the local ledger — nothing here.
      const refundish = classified === "REFUND_FULL" || classified === "REFUND_PARTIAL" ||
        classified === "REVERSED";
      const kind: PaymentObservation["kind"] = refundish
        ? classified === "REVERSED" ? "REVERSAL_NOTICE" : "REFUND_NOTICE"
        : classified === "UNPARSABLE" ? "UNCERTAIN" : classified;
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
          providerState: tracker.state,
          occurredAt: null,
        }),
      };
    },
  });
}
