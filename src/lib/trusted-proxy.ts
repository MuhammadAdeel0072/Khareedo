// Trusted-proxy configuration (Phase 2, area G).
//
// `clientIp()` and `requestOrigin()` both derive security-relevant values
// from proxy headers (`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`,
// `X-Forwarded-Proto`). Those headers are client-controlled unless a proxy
// the operator trusts overwrites them — so they are trusted ONLY when the
// deployment declares a trusted proxy.
//
// Set TRUSTED_PROXY_IPS to the comma-separated IPs of the proxies in front
// of the app (for example the Caddyfile host, which overwrites
// X-Forwarded-For with the real client IP:
// `header_up X-Forwarded-For {remote_host}`). The proxy MUST overwrite the
// forwarded headers with the real client values; a proxy that merely
// appends to them leaves the first entry attacker-controlled.
//
// Accepted entries (validated — see `parseTrustedProxyEntries`):
// - a single IPv4 address, e.g. `127.0.0.1` or `10.0.0.1`;
// - a single IPv6 address, e.g. `::1` or `2001:db8::1`;
// - a CIDR range, e.g. `10.0.0.0/24` (any address in the range) or
//   `10.0.0.1/32` / `2001:db8::1/128` (exactly one host — normalised to
//   the bare IP). Use a CIDR only for a subnet that contains proxies and
//   nothing else; never list a client range.
// Entries are whitespace-tolerant and deduplicated. An entry that is not
// a valid IP or CIDR — a hostname, a malformed address, an out-of-range
// prefix, or a `/0` range (which would trust everyone) — is logged with a
// loud `SECURITY` warning and IGNORED: it is never trusted. If every entry
// is invalid, the configuration is exactly as if the variable were unset.
//
// Honest limitation: Next.js route handlers cannot see the TCP peer IP, so
// this is an operator assertion, not a runtime peer check — the app cannot
// verify that the request actually came through a listed proxy. The CIDR
// matcher (`isTrustedProxyIp`) exists for callers that DO have a peer IP;
// `clientIp()` itself only gates on "a trusted proxy is configured".
// When the variable is unset, forwarded headers are ignored entirely and
// the client IP is reported as "unknown" (per-IP rate limits then share
// one global bucket, which is fail-safe: an attacker cannot evade the limit
// by spoofing a header, they can only share the bucket with everyone else).
// In production that unset state is logged once per process as a SECURITY
// warning (log only — the app still boots). See docs/DEPLOYMENT.md for
// the deployment requirements and the exact operator steps.

/** Result of parsing one raw `TRUSTED_PROXY_IPS` value. */
export interface ParsedTrustedProxyConfig {
  /** Valid entries, trimmed, deduplicated, `/32`/`/128` normalised to bare IPs. */
  valid: string[];
  /** Raw entries that failed validation (never trusted). */
  invalid: string[];
}

function parseIpv4Octets(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Digits only, no leading zeros (except "0" itself — "01" is ambiguous
    // with octal in some parsers, so it is rejected rather than guessed).
    if (!/^(0|[1-9][0-9]*)$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function parseIpv6Groups(value: string): number[] | null {
  // No zone ids (`fe80::1%eth0`) — they are link-local interface names,
  // not something a proxy list should contain.
  if (value.includes("%")) return null;
  const compressed = value.split("::");
  if (compressed.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === "") return null;
      if (i === parts.length - 1 && part.includes(".")) {
        // Embedded IPv4 tail, e.g. `::ffff:10.0.0.1` — counts as 2 groups.
        const v4 = parseIpv4Octets(part);
        if (!v4) return null;
        groups.push(((v4[0] << 8) | v4[1]) >>> 0, ((v4[2] << 8) | v4[3]) >>> 0);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        groups.push(parseInt(part, 16));
      }
    }
    return groups;
  };

  if (compressed.length === 1) {
    const groups = parseSide(compressed[0]);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }
  const left = parseSide(compressed[0]);
  const right = parseSide(compressed[1]);
  if (!left || !right) return null;
  // `::` must compress at least one group; otherwise the address has
  // more than 8 groups and is malformed.
  if (left.length + right.length >= 8) return null;
  const zeros = 8 - left.length - right.length;
  return [...left, ...new Array<number>(zeros).fill(0), ...right];
}

/**
 * Validate and normalise one entry. Returns the normalised entry, or null
 * when the entry is not a valid single IP or CIDR range. A `/32` (IPv4)
 * or `/128` (IPv6) CIDR is normalised to the bare IP so it deduplicates
 * against the same bare IP.
 */
function normaliseEntry(entry: string): string | null {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    if (parseIpv4Octets(entry)) return entry;
    if (parseIpv6Groups(entry)) return entry.toLowerCase();
    return null;
  }
  const address = entry.slice(0, slash);
  const prefixText = entry.slice(slash + 1);
  // Prefix must be plain digits — no sign, no spaces, no second slash.
  if (!/^[0-9]+$/.test(prefixText) || entry.indexOf("/", slash + 1) !== -1) {
    return null;
  }
  const prefix = Number(prefixText);
  const isV6 = address.includes(":");
  const maxPrefix = isV6 ? 128 : 32;
  // A /0 range matches every address: it would trust forwarded headers
  // from anyone. That is never a legitimate proxy list, so it is rejected
  // rather than silently trusted.
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > maxPrefix) return null;
  if (isV6) {
    if (!parseIpv6Groups(address)) return null;
    return prefix === 128 ? address.toLowerCase() : `${address.toLowerCase()}/${prefix}`;
  }
  if (!parseIpv4Octets(address)) return null;
  return prefix === 32 ? address : `${address}/${prefix}`;
}

/**
 * Pure parser for a raw `TRUSTED_PROXY_IPS` value: split on commas, trim
 * whitespace, drop empties, deduplicate, and split valid from invalid.
 * Never throws; invalid entries are reported, never trusted.
 */
export function parseTrustedProxyEntries(raw: string): ParsedTrustedProxyConfig {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const normalised = normaliseEntry(entry);
    if (normalised === null) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    valid.push(normalised);
  }
  return { valid, invalid };
}

// The parsed config is cached per distinct raw value (parsing runs on the
// request path via `clientIp()`/`requestOrigin()`, so re-parsing on every
// request would also re-log). A changed env value re-parses; warnings are
// logged at most once per distinct raw value per process.
let cachedRaw: string | null = null;
let cachedValid: string[] = [];
const warnedInvalidForRaw = new Set<string>();
const warnedUnsetForKey = new Set<string>();

function maybeWarnUnset(validCount: number, raw: string): void {
  if (process.env.NODE_ENV !== "production") return;
  // The build step runs with NODE_ENV=production but its env is CI's, not
  // the runtime's — warning there would be noise about the wrong env.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (validCount > 0) return;
  const key = `${process.env.NODE_ENV}|${process.env.NEXT_PHASE ?? ""}|${raw}`;
  if (warnedUnsetForKey.has(key)) return;
  warnedUnsetForKey.add(key);
  console.warn(
    "[trusted-proxy] SECURITY: TRUSTED_PROXY_IPS is not set (or has no valid " +
      "entries) in production — forwarded headers (X-Forwarded-For, X-Real-IP, " +
      "X-Forwarded-Host, X-Forwarded-Proto) are IGNORED and every client is " +
      "reported as \"unknown\". Per-IP rate limits collapse into one shared " +
      "bucket, so one abusive client can exhaust the login/checkout/quote " +
      "budget for everyone. Set TRUSTED_PROXY_IPS to the production proxy's " +
      "IP(s) — see docs/DEPLOYMENT.md. The app keeps running in this " +
      "fail-safe posture; this is a warning, not a startup failure."
  );
}

function loadConfig(): string[] {
  const raw = process.env.TRUSTED_PROXY_IPS ?? "";
  if (cachedRaw === raw) return cachedValid;
  cachedRaw = raw;
  const { valid, invalid } = parseTrustedProxyEntries(raw);
  cachedValid = valid;
  if (invalid.length > 0 && !warnedInvalidForRaw.has(raw)) {
    warnedInvalidForRaw.add(raw);
    console.warn(
      `[trusted-proxy] SECURITY: TRUSTED_PROXY_IPS contains ${invalid.length} ` +
        `invalid entr${invalid.length === 1 ? "y" : "ies"} that will be IGNORED ` +
        `(never trusted): ${invalid.join(", ")}. ` +
        `Valid entries: ${valid.length > 0 ? valid.join(", ") : "(none — forwarded headers will be ignored)"}. ` +
        "Use single IPv4/IPv6 addresses or CIDR ranges only — see docs/DEPLOYMENT.md."
    );
  }
  // Production unset warning, once per process: evaluated here so it fires
  // on first use after boot even before any explicit startup call.
  maybeWarnUnset(valid.length, raw);
  return valid;
}

export function trustedProxyIps(): string[] {
  return [...loadConfig()];
}

/** True when the operator has asserted a trusted proxy is in front. */
export function isTrustedProxyConfigured(): boolean {
  return loadConfig().length > 0;
}

function ipv4ToInt(octets: number[]): number {
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>>
    0
  );
}

function ipv6InCidr(network: number[], address: number[], prefix: number): boolean {
  const fullGroups = Math.floor(prefix / 16);
  for (let i = 0; i < fullGroups; i++) {
    if (network[i] !== address[i]) return false;
  }
  const remaining = prefix % 16;
  if (remaining > 0) {
    const mask = (0xffff << (16 - remaining)) & 0xffff;
    if ((network[fullGroups] & mask) !== (address[fullGroups] & mask)) {
      return false;
    }
  }
  return true;
}

/**
 * True when `ip` is one of the configured trusted proxies: an exact match
 * against a bare-IP entry, or inside a configured CIDR range. Bare IPv6
 * entries match case-insensitively; CIDR matching is by masked value, so
 * host bits set in the configured range (e.g. `10.0.0.1/24`) still match
 * the whole range. Returns false when nothing is configured (fail closed)
 * or when `ip` is not a valid IP. This is the matcher for callers that
 * have a real peer IP; `clientIp()` cannot use it because Next.js route
 * handlers cannot see the TCP peer (see the module header).
 */
export function isTrustedProxyIp(ip: string): boolean {
  const candidate = ip.trim();
  if (candidate.length === 0) return false;
  for (const entry of loadConfig()) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      if (entry.toLowerCase() === candidate.toLowerCase()) return true;
      continue;
    }
    const address = entry.slice(0, slash);
    const prefix = Number(entry.slice(slash + 1));
    if (address.includes(":")) {
      const network = parseIpv6Groups(address);
      const parsed = parseIpv6Groups(candidate);
      if (network && parsed && ipv6InCidr(network, parsed, prefix)) return true;
    } else {
      const network = parseIpv4Octets(address);
      const parsed = parseIpv4Octets(candidate);
      if (!network || !parsed) continue;
      const shift = 32 - prefix;
      if ((ipv4ToInt(network) >>> shift) === (ipv4ToInt(parsed) >>> shift)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Production startup warning for the unset/unconfigured state: log only,
 * never throw — the app must still boot. Safe to call repeatedly; it logs
 * at most once per distinct configuration. Wire it into the server
 * startup hook (`src/instrumentation.ts` `register()`) for an explicit
 * boot-time warning; it is also evaluated lazily on first use, so a
 * production process that never calls it still warns on its first
 * trusted-proxy evaluation.
 */
export function warnTrustedProxyStartup(): void {
  maybeWarnUnset(loadConfig().length, process.env.TRUSTED_PROXY_IPS ?? "");
}
