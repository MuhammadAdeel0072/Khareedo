import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";

const opaque = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
// Internal canonical decimal strings, not a Safepay response format. Bound to signed BigInt storage.
const minor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => BigInt(value) <= BigInt("9223372036854775807"));
export const paymentObservationSchema = z.object({
  provider: opaque, environment: z.enum(["sandbox", "production"]), merchantAccountRef: opaque,
  merchantIdentity: opaque, observationId: opaque, orderId: id, paymentId: id,
  attemptNumber: z.number().int().positive().max(2_147_483_647), trackerToken: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/),
  owner: z.object({ kind: z.literal("USER"), hash: z.string().regex(/^[a-f0-9]{64}$/), userId: id }).strict(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  // Provider-reported quote amount. Null when the documented payload shape carries no
  // financial fields (e.g. the documented Safepay payment.failed webhook) — the locally
  // expected amount is never substituted for a missing provider-reported amount.
  amountMinor: minor.nullable(),
  // These are application domain facts. Only an approved adapter may classify a provider response into them.
  // REFUND_CONFIRMED: authenticated refund event carrying an attributable amount (refundMinor).
  // REVERSAL_NOTICE: documented reversal evidence (void.succeeded / authorization.reversed /
  //   TRACKER_REVERSED). Reversals are never treated as post-capture refunds.
  kind: z.enum(["CAPTURE_CONFIRMED", "PENDING", "UNCERTAIN", "FAILURE_CONFIRMED", "REFUND_CONFIRMED",
    "REFUND_NOTICE", "REVERSAL_NOTICE", "REVIEW_REQUIRED"]),
  capturedMinor: minor.nullable(), refundMinor: minor.nullable(),
  // Documented tracker state the adapter observed, when the channel carries one; null/absent
  // otherwise. Never a settlement capability by itself — settlement corroborates it against
  // local records. Optional (not defaulted) so locally-constructed observations in tests
  // remain valid when the field carries no meaning for their kind.
  providerState: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/).nullish(),
  occurredAt: z.string().datetime().nullable(),
}).strict();
export type PaymentObservation = z.infer<typeof paymentObservationSchema>;
export type EvidenceChannel = "WEBHOOK" | "RECONCILIATION";
export type VerificationInput = Readonly<{
  provider: string; environment: "sandbox" | "production"; merchantAccountRef: string;
  channel: EvidenceChannel; body: Uint8Array; headers: Readonly<Record<string, string>>;
}>;
export type AdapterVerification = { kind: "authenticated"; observation: unknown } | { kind: "rejected" };
export interface PaymentVerificationAdapter {
  readonly provider: string;
  readonly channel: EvidenceChannel;
  readonly contractVersion: string;
  readonly merchantAccountRef: string;
  readonly environment: "sandbox" | "production";
  readonly merchantIdentity: string;
  // Persist only documented authentication headers, encrypted with the original bytes.
  readonly retainedHeaderNames: readonly string[];
  verify(input: VerificationInput): Promise<AdapterVerification>;
}
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const trackerIdentity = (o: Pick<PaymentObservation, "provider" | "environment" | "merchantAccountRef" | "trackerToken">) =>
  sha256(JSON.stringify([o.provider, o.environment, o.merchantAccountRef, o.trackerToken]));
// Zod supplies a fixed property order; adapter object insertion order is not an identity.
export const observationDigest = (o: PaymentObservation, channel: EvidenceChannel, contractVersion: string) =>
  sha256(JSON.stringify(["KHAREEDO_OBSERVATION_V1", channel, contractVersion, paymentObservationSchema.parse(o)]));
