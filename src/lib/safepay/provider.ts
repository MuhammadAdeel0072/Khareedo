import "server-only";
import type { SafepayConfig } from "./config";
import { authResponseSchema, localId, refundResponseSchema, trackerResponseSchema,
  type ProviderFailure, type Tracker } from "./contracts";

export type HttpTransport = (url: URL, init: RequestInit) => Promise<Response>;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PROVIDER_MESSAGE_LENGTH = 160;

export class AuthenticationToken {
  #value: string;
  constructor(value: string) { this.#value = value; }
  revealForCheckout(): string { return this.#value; }
  toJSON() { return "[REDACTED authentication token]"; }
}

class TransportFailure extends Error {
  constructor(readonly code: "TIMEOUT" | "NETWORK_ERROR" | "INVALID_RESPONSE") { super(code); }
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new TransportFailure("INVALID_RESPONSE");
  }
  if (!response.body) throw new TransportFailure("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_BODY_BYTES) throw new TransportFailure("INVALID_RESPONSE");
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TransportFailure("INVALID_RESPONSE");
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function boundedText(response: Response): Promise<string | null> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_BODY_BYTES) return null;
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function sanitizeProviderCode(value: string | undefined, credentials: string[]): string | undefined {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(value) ||
      credentials.some(credential => credential.length > 0 && value.includes(credential)) ||
      /^(?:sec_|sk_|pk_|eyJ)/i.test(value)) return undefined;
  return value;
}

function sanitizeProviderMessage(value: string | undefined, credentials: string[]): string | undefined {
  if (!value) return undefined;
  let message = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  for (const credential of credentials) {
    if (credential) message = message.split(credential).join("[redacted]");
  }
  message = message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:api[_ -]?key|secret|token|password|authorization|credential)\s*[:=]\s*["']?[^,\s;"']+/gi, "[redacted]")
    .replace(/\b(?:customer(?:[_ -]?(?:name|id))?|user(?:[_ -]?(?:name|id))?|name|email|phone|address|card(?:[_ -]?(?:number|holder))?)\b(?:\s*[:=]\s*|\s+)[^,;]+/gi, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[redacted]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, "[redacted]")
    .slice(0, MAX_PROVIDER_MESSAGE_LENGTH)
    .trim();
  return message.length > 0 ? message : undefined;
}

async function providerErrorDetails(response: Response, credentials: string[]) {
  const text = await boundedText(response);
  if (text === null) return {};
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return {}; }
  const root = record(payload);
  if (!root) return {};
  const error = record(root.error);
  const status = record(root.status);
  const errors = Array.isArray(status?.errors) ? status.errors : Array.isArray(root.errors) ? root.errors : [];
  const firstError = record(errors[0]);
  const providerErrorCode = sanitizeProviderCode(firstString(
    root.error_code, root.errorCode, root.code, error?.error_code, error?.code, firstError?.code,
  ), credentials);
  const providerMessage = sanitizeProviderMessage(firstString(
    root.message, root.error_description, error?.message, status?.message,
    typeof errors[0] === "string" ? errors[0] : firstError?.message,
  ), credentials);
  return {
    ...(providerErrorCode ? { providerErrorCode } : {}),
    ...(providerMessage ? { providerMessage } : {}),
  };
}

// No automatic POST retries. A transport failure does not prove that a tracker was not created.
export function createSafepayProvider(config: SafepayConfig, transport: HttpTransport = (url, init) => fetch(url, init)) {
  type ProviderReply = {
    status: number; ok: boolean; json?: unknown; bodyBytes?: Uint8Array;
    providerErrorCode?: string; providerMessage?: string;
  };
  async function send(method: "POST" | "GET", path: string, body?: unknown, parseJson = true): Promise<ProviderReply> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        const headers = config.requestHeaders();
        if (body !== undefined) headers.set("Content-Type", "application/json");
        let response: Response;
        try {
          response = await transport(new URL(path, config.apiOrigin), {
            method, headers, ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal, redirect: "manual", cache: "no-store", credentials: "omit",
          });
        } catch { throw new TransportFailure("NETWORK_ERROR"); }
        if (!response.ok || response.redirected) {
          const error = await providerErrorDetails(response, [
            config.merchantApiKey(), headers.get("X-SFPY-MERCHANT-SECRET") ?? "",
          ]);
          return { status: response.status, ok: false, ...error };
        }
        if (!parseJson) {
          void response.body?.cancel().catch(() => {});
          return { status: response.status, ok: true };
        }
        // Reporter evidence keeps the exact response bytes; the parsed value is only a view.
        const json = await boundedJson(response);
        return { status: response.status, ok: true, json, bodyBytes: json === undefined ? undefined : encodeJsonBytes(json) };
      };
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new TransportFailure("TIMEOUT")); }, config.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  // Preserves the documented POST contract, including no-retry semantics.
  const post = (path: string, body?: unknown, parseJson = true) => send("POST", path, body, parseJson);

  return Object.freeze({
    async createTracker(input: { orderId: string; paymentId: string; amountMinor: bigint }): Promise<
      { kind: "created"; tracker: Tracker } | ProviderFailure
    > {
      if (!localId.safeParse(input.orderId).success || !localId.safeParse(input.paymentId).success ||
          typeof input.amountMinor !== "bigint" || input.amountMinor <= BigInt(0) ||
          input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { kind: "failed", code: "INVALID_REQUEST" };
      }
      try {
        const response = await post("/order/payments/v3/", {
            merchant_api_key: config.merchantApiKey(), intent: "CYBERSOURCE", mode: "payment",
            entry_mode: config.entryMode, currency: "PKR", amount: Number(input.amountMinor),
          });
        // Error/redirect semantics do not establish absence of a side effect.
        if (!response.ok) return {
          kind: "uncertain", code: "HTTP_ERROR", httpStatus: response.status,
          ...(response.providerErrorCode ? { providerErrorCode: response.providerErrorCode } : {}),
          ...(response.providerMessage ? { providerMessage: response.providerMessage } : {}),
        };
        const parsed = trackerResponseSchema.safeParse(response.json);
        if (!parsed.success) return { kind: "uncertain", code: "INVALID_RESPONSE" };
        const value = parsed.data.data.tracker;
        const tracker: Tracker = {
          token: value.token, environment: value.environment, state: value.state, intent: value.intent,
          mode: value.mode, entryMode: value.entry_mode,
          currency: value.purchase_totals.quote_amount.currency,
          amountMinor: BigInt(value.purchase_totals.quote_amount.amount),
        };
        if (parsed.data.status.errors.length || !parsed.data.data.capabilities.CYBERSOURCE ||
            tracker.environment !== config.environment || tracker.state !== "TRACKER_STARTED" ||
            tracker.intent !== "CYBERSOURCE" || tracker.mode !== "payment" ||
            tracker.entryMode !== config.entryMode || tracker.currency !== "PKR" ||
            tracker.amountMinor !== input.amountMinor) {
          return { kind: "uncertain", code: "TRACKER_MISMATCH", tracker };
        }
        return { kind: "created", tracker };
      } catch (error) {
        return { kind: "uncertain", code: error instanceof TransportFailure ? error.code : "INVALID_RESPONSE" };
      }
    },
    async attachTrackerMetadata(input: {
      trackerToken: string; orderId: string;
    }): Promise<{ kind: "updated" } | ProviderFailure> {
      if (!input.trackerToken || input.trackerToken.length > 2048 ||
          /[\u0000-\u0020\u007f]/.test(input.trackerToken) ||
          !localId.safeParse(input.orderId).success) {
        return { kind: "failed", code: "INVALID_REQUEST" };
      }
      try {
        const response = await post(
          `/order/payments/v3/${encodeURIComponent(input.trackerToken)}/metadata`,
          { data: { order_id: input.orderId } },
          false,
        );
        if (!response.ok) return {
          kind: "failed", code: "HTTP_ERROR", httpStatus: response.status,
          ...(response.providerErrorCode ? { providerErrorCode: response.providerErrorCode } : {}),
          ...(response.providerMessage ? { providerMessage: response.providerMessage } : {}),
        };
        return { kind: "updated" };
      } catch (error) {
        return { kind: "failed", code: error instanceof TransportFailure ? error.code : "INVALID_RESPONSE" };
      }
    },
    // Documented classic refund endpoint: POST /order/payments/v3/{tracker}/refund with
    // X-SFPY-MERCHANT-SECRET and an integer minor-unit body { currency, amount }.
    // Same no-retry semantics as tracker creation: a transport failure or 5xx does NOT prove
    // the refund was not processed, so those outcomes are "uncertain" and the caller must
    // resolve them through reconciliation, never through an automatic resubmission.
    // A 4xx refusal (except 408) proves the provider rejected the request before processing
    // it, so no refund can exist: that is a definitive "failed" outcome.
    // A 2xx response is an accepted submission — it is NEVER accounting evidence on its own;
    // final refund accounting requires authenticated webhook/reconciliation evidence.
    async submitRefund(input: { trackerToken: string; amountMinor: bigint }): Promise<
      { kind: "submitted"; providerState?: string } | ProviderFailure
    > {
      if (!input.trackerToken || input.trackerToken.length > 2048 ||
          /[\u0000-\u0020\u007f]/.test(input.trackerToken) ||
          typeof input.amountMinor !== "bigint" || input.amountMinor <= BigInt(0) ||
          input.amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { kind: "failed", code: "INVALID_REQUEST" };
      }
      try {
        const response = await post(
          `/order/payments/v3/${encodeURIComponent(input.trackerToken)}/refund`,
          { currency: "PKR", amount: Number(input.amountMinor) },
        );
        if (!response.ok) {
          const definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
          return {
            kind: definitive ? "failed" : "uncertain", code: "HTTP_ERROR", httpStatus: response.status,
            ...(response.providerErrorCode ? { providerErrorCode: response.providerErrorCode } : {}),
            ...(response.providerMessage ? { providerMessage: response.providerMessage } : {}),
          };
        }
        // Advisory state extraction only. An unparsable 2xx body still means the request
        // was accepted; the parsed state is never used to finalize accounting.
        const parsed = refundResponseSchema.safeParse(response.json);
        const state = parsed.success ? parsed.data.data.tracker.state : undefined;
        return state ? { kind: "submitted", providerState: state } : { kind: "submitted" };
      } catch (error) {
        return { kind: "uncertain", code: error instanceof TransportFailure ? error.code : "INVALID_RESPONSE" };
      }
    },
    // Documented status lookup: GET /reporter/api/v1/payments/{tracker} (Express Checkout guide,
    // "Get the outcome"). GET is side-effect-free, so transport failures are "failed", not "uncertain".
    async fetchTracker(input: { trackerToken: string }): Promise<
      { kind: "fetched"; status: number; json: unknown; bodyBytes: Uint8Array } | ProviderFailure
    > {
      if (!input.trackerToken || input.trackerToken.length > 2048 ||
          /[\u0000-\u0020\u007f]/.test(input.trackerToken)) {
        return { kind: "failed", code: "INVALID_REQUEST" };
      }
      try {
        const response = await send("GET", `/reporter/api/v1/payments/${encodeURIComponent(input.trackerToken)}`);
        if (!response.ok || response.json === undefined || response.bodyBytes === undefined) {
          return {
            kind: "failed", code: response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR", httpStatus: response.status,
            ...(response.providerErrorCode ? { providerErrorCode: response.providerErrorCode } : {}),
            ...(response.providerMessage ? { providerMessage: response.providerMessage } : {}),
          };
        }
        return { kind: "fetched", status: response.status, json: response.json, bodyBytes: response.bodyBytes };
      } catch (error) {
        return { kind: "failed", code: error instanceof TransportFailure ? error.code : "INVALID_RESPONSE" };
      }
    },
    async authenticate(): Promise<{ kind: "authenticated"; token: AuthenticationToken } | ProviderFailure> {
      try {
        // Documented merchant-secret POST with no body; no assumed token lifetime.
        const response = await post("/client/passport/v1/token");
        if (!response.ok) return {
          kind: "failed", code: "HTTP_ERROR", httpStatus: response.status,
          ...(response.providerErrorCode ? { providerErrorCode: response.providerErrorCode } : {}),
          ...(response.providerMessage ? { providerMessage: response.providerMessage } : {}),
        };
        const parsed = authResponseSchema.safeParse(response.json);
        if (!parsed.success || parsed.data.status?.errors.length) return { kind: "failed", code: "INVALID_RESPONSE" };
        return { kind: "authenticated", token: new AuthenticationToken(parsed.data.data) };
      } catch (error) {
        return { kind: "failed", code: error instanceof TransportFailure ? error.code : "INVALID_RESPONSE" };
      }
    },
  });
}
export type SafepayProvider = ReturnType<typeof createSafepayProvider>;

// Canonical re-encoding of a parsed JSON value. Used only where the caller needs byte-stable
// reconciliation evidence derived from the bounded provider response it just received.
function encodeJsonBytes(json: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(json), "utf8");
}
