// SSRF guard — shared by the banner image-import endpoint (and reusable by
// any server-side fetch of an administrator-supplied URL).
//
// Strategy: never trust the hostname string. Parse the URL, reject anything
// that is not plain http/https, reject embedded credentials, then resolve
// DNS and validate EVERY resolved address against non-public ranges before
// the first byte is fetched. The caller must also re-validate each redirect
// hop (redirects are followed manually in the import route for exactly this
// reason) and cap the response size.
//
// Blocked ranges: loopback, RFC1918 private, CGNAT 100.64/10, link-local
// 169.254/16 (includes the cloud metadata endpoint 169.254.169.254),
// 0.0.0.0/8, 192.0.0/24, 192.0.2/24 + 198.51.100/24 + 203.0.113/24
// (documentation), 198.18/15 (benchmarking), 240/4 + 255.255.255.255
// (reserved/broadcast), IPv6 loopback/unique-local/link-local/ULA.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inCidr(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

const V4_BLOCKED: Array<{ base: string; bits: number; label: string }> = [
  { base: "0.0.0.0", bits: 8, label: "reserved" },
  { base: "10.0.0.0", bits: 8, label: "a private address" },
  { base: "100.64.0.0", bits: 10, label: "a CGNAT address" },
  { base: "127.0.0.0", bits: 8, label: "a loopback address" },
  { base: "169.254.0.0", bits: 16, label: "a link-local address" },
  { base: "172.16.0.0", bits: 12, label: "a private address" },
  { base: "192.0.0.0", bits: 24, label: "reserved" },
  { base: "192.0.2.0", bits: 24, label: "reserved" },
  { base: "192.168.0.0", bits: 16, label: "a private address" },
  { base: "198.18.0.0", bits: 15, label: "reserved" },
  { base: "198.51.100.0", bits: 24, label: "reserved" },
  { base: "203.0.113.0", bits: 24, label: "reserved" },
  { base: "240.0.0.0", bits: 4, label: "reserved" },
];

/** True when the address (v4 or v6 literal) is not publicly routable. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = ipv4ToInt(address);
    if (n === null) return true;
    if (n === 0xffffffff) return true; // broadcast
    return V4_BLOCKED.some((r) => inCidr(n, r.base, r.bits));
  }
  if (family === 6) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::" || lower === "::1") return true; // unspecified / loopback
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return true; // link-local fe80::/10
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice(7);
      return isIP(mapped) === 4 ? isPrivateAddress(mapped) : true;
    }
    return false;
  }
  return true; // not an IP we understand → treat as unsafe
}

/**
 * Validate an http(s) URL for server-side fetching: public scheme, no
 * credentials, and every DNS-resolved address must be publicly routable.
 * Returns the normalized URL on success; throws SsrfBlockedError otherwise.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError("The URL is not valid.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SsrfBlockedError("Only http(s) image URLs can be imported.");
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("URLs with embedded credentials cannot be imported.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Literal IP hostnames skip DNS; named hosts must resolve to public addresses.
  if (isIP(host) === 0) {
    let records: Array<{ address: string }>;
    try {
      records = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new SsrfBlockedError("The image host could not be resolved.");
    }
    if (records.length === 0) {
      throw new SsrfBlockedError("The image host could not be resolved.");
    }
    for (const record of records) {
      if (isPrivateAddress(record.address)) {
        throw new SsrfBlockedError("This URL points to a non-public address and cannot be imported.");
      }
    }
  } else if (isPrivateAddress(host)) {
    throw new SsrfBlockedError("This URL points to a non-public address and cannot be imported.");
  }

  return url;
}
