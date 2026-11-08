import "server-only";
import { createHmac } from "node:crypto";

const HOSTS = {
  sandbox: { api: "https://sandbox.api.getsafepay.com", checkout: "https://sandbox.api.getsafepay.com/embedded/" },
  production: { api: "https://api.getsafepay.com", checkout: "https://getsafepay.com/embedded/" },
} as const;

export type SafepayEnvironment = keyof typeof HOSTS;
export type SafepayEntryMode = "flex" | "raw";

export interface SafepayConfig {
  readonly environment: SafepayEnvironment;
  readonly apiOrigin: string;
  readonly checkoutUrl: string;
  readonly entryMode: SafepayEntryMode;
  readonly merchantAccountRef: string;
  readonly siteOrigin: string;
  readonly timeoutMs: number;
  merchantApiKey(): string;
  requestHeaders(): Headers;
  signReturnState(bytes: string): Buffer;
  toJSON(): Record<string, unknown>;
}

export class SafepayConfigurationError extends Error {
  constructor() {
    super("Safepay server configuration is incomplete or invalid.");
    this.name = "SafepayConfigurationError";
  }
}

function opaque(value: string | undefined, min = 1, max = 4096): string {
  if (!value || value.length < min || value.length > max || /[^\x21-\x7e]/.test(value)) {
    throw new SafepayConfigurationError();
  }
  return value;
}

// Lazy loading only. Never serialize env, validation inputs, credentials or request headers.
// siteOriginOverride (request-scoped, e.g. derived from proxy headers) wins over the
// SAFEPAY_SITE_ORIGIN env var, which remains for fixed-domain production deploys.
export function loadSafepayConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  siteOriginOverride?: string,
): SafepayConfig {
  const environment = env.SAFEPAY_ENVIRONMENT;
  const entryMode = env.SAFEPAY_ENTRY_MODE;
  if ((environment !== "sandbox" && environment !== "production") || (entryMode !== "flex" && entryMode !== "raw")) {
    throw new SafepayConfigurationError();
  }
  const publicKey = opaque(env.SAFEPAY_MERCHANT_API_KEY);
  const secretKey = opaque(env.SAFEPAY_SECRET_KEY);
  const stateSecret = opaque(env.SAFEPAY_RETURN_STATE_SECRET, 32);
  const merchantAccountRef = opaque(env.SAFEPAY_MERCHANT_ACCOUNT_REF, 1, 128);
  if (stateSecret === secretKey || stateSecret === publicKey) throw new SafepayConfigurationError();
  let site: URL;
  try { site = new URL(siteOriginOverride ?? env.SAFEPAY_SITE_ORIGIN ?? ""); } catch { throw new SafepayConfigurationError(); }
  if (site.username || site.password || site.search || site.hash || site.pathname !== "/" ||
      (site.protocol !== "https:" && !(environment === "sandbox" && site.protocol === "http:" &&
        (site.hostname === "localhost" || site.hostname === "127.0.0.1")))) {
    throw new SafepayConfigurationError();
  }
  const timeoutMs = env.SAFEPAY_TIMEOUT_MS === undefined ? 10000 : Number(env.SAFEPAY_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new SafepayConfigurationError();
  const config: SafepayConfig = {
    environment, apiOrigin: HOSTS[environment].api, checkoutUrl: HOSTS[environment].checkout,
    entryMode, merchantAccountRef, siteOrigin: site.origin, timeoutMs,
    merchantApiKey: () => publicKey,
    requestHeaders: () => new Headers({ Accept: "application/json", "X-SFPY-MERCHANT-SECRET": secretKey }),
    signReturnState: (bytes) => createHmac("sha256", stateSecret).update(bytes).digest(),
    toJSON: () => ({ environment, entryMode, merchantAccountRef, configured: true }),
  };
  return Object.freeze(config);
}

export function isSafepaySandboxSessionConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.SAFEPAY_ENVIRONMENT !== "sandbox") return false;
  try {
    loadSafepayConfig(env);
    return true;
  } catch (error) {
    if (error instanceof SafepayConfigurationError) return false;
    throw error;
  }
}

// Background sweeps (reconciliation retries) run without a request, so no visitor
// origin exists to derive. The reconciliation channel only calls the reporter API and
// never builds customer-facing URLs, so a non-routable placeholder origin keeps the
// same validation while making it structurally impossible to hand this config to a
// redirect/return builder and produce a usable link.
export function loadSafepayApiOnlyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SafepayConfig {
  return loadSafepayConfig(env, "https://api-only-sweep.invalid/");
}

// Safepay dashboard "Developers > Endpoints" shared webhook secret. Kept separate from
// loadSafepayConfig: hosted-session activation and webhook activation are independent phases.
// Returns null when unset; a set-but-invalid secret throws SafepayConfigurationError.
export function loadSafepayWebhookSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (env.SAFEPAY_WEBHOOK_SECRET === undefined) return null;
  try {
    return opaque(env.SAFEPAY_WEBHOOK_SECRET, 16);
  } catch (error) {
    if (error instanceof SafepayConfigurationError) throw error;
    throw new SafepayConfigurationError();
  }
}
