import "server-only";
import { paymentObservationSchema, observationDigest, sha256, type EvidenceChannel, type PaymentObservation,
  type VerificationInput } from "@/lib/payments/evidence-contract";
import { approvedPaymentVerifier } from "@/lib/payments/verification-registry";

declare const trustedEvidenceBrand: unique symbol;
export type TrustedPaymentEvidence = Readonly<{ [trustedEvidenceBrand]: true }>;
export type VerifiedEvidenceData = Readonly<{ observation: PaymentObservation; channel: EvidenceChannel;
  contractVersion: string; rawSha256: string; businessSha256: string; issuedAt: number }>;
const issuedProofs = new WeakMap<object, VerifiedEvidenceData>();
const MAX_BODY = 1_048_576;

export function copyVerificationInput(input: VerificationInput): VerificationInput {
  if (!input || !["WEBHOOK", "RECONCILIATION"].includes(input.channel) ||
      !["sandbox", "production"].includes(input.environment) ||
      typeof input.provider !== "string" || typeof input.merchantAccountRef !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(input.provider) || !/^[\x21-\x7e]{1,256}$/.test(input.merchantAccountRef) ||
      !(input.body instanceof Uint8Array) || input.body.byteLength < 1 || input.body.byteLength > MAX_BODY ||
      !input.headers || typeof input.headers !== "object" || Array.isArray(input.headers) ||
      Object.keys(input.headers).length > 32) throw new Error("Invalid verification input.");
  const headers: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(input.headers)) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(key) || typeof value !== "string" || value.length > 8192 ||
        /[\r\n\u0000]/.test(value) || key in headers) throw new Error("Invalid verification headers.");
    headers[key] = value;
  }
  return Object.freeze({ provider: input.provider, environment: input.environment, merchantAccountRef: input.merchantAccountRef,
    channel: input.channel, body: Uint8Array.from(input.body), headers: Object.freeze(headers) });
}

export async function authenticatePaymentEvidence(raw: VerificationInput, now = new Date()): Promise<
  { kind: "verified"; proof: TrustedPaymentEvidence; retainedHeaders: Readonly<Record<string, string>> } |
  { kind: "blocked"; code: "INVALID_INPUT" | "VERIFICATION_DISABLED" | "UNVERIFIED_EVIDENCE" }> {
  let input: VerificationInput;
  try { input = copyVerificationInput(raw); } catch { return { kind: "blocked", code: "INVALID_INPUT" }; }
  try {
    const adapter = approvedPaymentVerifier(input);
    if (!adapter) return { kind: "blocked", code: "VERIFICATION_DISABLED" };
    if (!Number.isFinite(now.getTime()) || adapter.provider !== input.provider || adapter.channel !== input.channel ||
        adapter.environment !== input.environment || adapter.merchantAccountRef !== input.merchantAccountRef ||
        !/^[\x21-\x7e]{1,128}$/.test(adapter.contractVersion) || !adapter.merchantIdentity ||
        adapter.retainedHeaderNames.length > 16) throw new Error("Unapproved verification scope.");
    const rawSha256 = sha256(input.body);
    const result = await adapter.verify(input);
    if (result.kind !== "authenticated" || sha256(input.body) !== rawSha256) throw new Error("Unverified evidence.");
    const observation = paymentObservationSchema.parse(result.observation);
    if (observation.provider !== input.provider || observation.environment !== input.environment ||
        observation.merchantAccountRef !== input.merchantAccountRef || observation.merchantIdentity !== adapter.merchantIdentity)
      throw new Error("Merchant identity not established.");
    const retainedHeaders: Record<string, string> = Object.create(null);
    for (const name of adapter.retainedHeaderNames) {
      if (!/^[a-z0-9-]{1,80}$/.test(name) || ["cookie", "authorization", "proxy-authorization"].includes(name))
        throw new Error("Unsafe retained authentication header.");
      if (input.headers[name] !== undefined) retainedHeaders[name] = input.headers[name];
    }
    Object.freeze(observation.owner); Object.freeze(observation);
    const data = Object.freeze({ observation, channel: input.channel, contractVersion: adapter.contractVersion,
      rawSha256, businessSha256: observationDigest(observation, input.channel, adapter.contractVersion), issuedAt: now.getTime() });
    const proof = Object.freeze(Object.create(null)) as TrustedPaymentEvidence;
    issuedProofs.set(proof, data);
    return { kind: "verified", proof, retainedHeaders: Object.freeze(retainedHeaders) };
  } catch { return { kind: "blocked", code: "UNVERIFIED_EVIDENCE" }; }
}

/** Runtime provenance gate. A cast, deserialized JSON, copied object or DB flag cannot forge a proof. */
export function readTrustedPaymentEvidence(proof: unknown, now: Date): VerifiedEvidenceData | null {
  if (!proof || typeof proof !== "object") return null;
  const data = issuedProofs.get(proof);
  // Five minutes is a local in-process capability lifetime, not a provider timestamp/retry contract.
  return data && Number.isFinite(now.getTime()) && now.getTime() >= data.issuedAt &&
    now.getTime() - data.issuedAt <= 300_000 ? data : null;
}
