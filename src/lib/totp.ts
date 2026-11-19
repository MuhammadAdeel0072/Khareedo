// TOTP (RFC 6238) for administrator MFA (PR-10). Implemented from scratch
// on Node's built-in crypto — no TOTP dependency — and verified against the
// RFC 6238 test vectors in tests/unit/admin-mfa-totp.test.ts.
//
// - Secret: 20 cryptographically secure random bytes (160 bits, RFC 4226),
//   base32-encoded (32 chars) for display and for the otpauth:// URL.
// - Algorithm: HMAC-SHA1, 6 digits, 30-second period (the authenticator-app
//   default; Google/Microsoft Authenticator and Authy all support it).
// - Verification window: the current time step plus/minus one step (90s
//   total), to allow for clock skew between the server and the admin's
//   phone. A code is only accepted once per time step: verifyTotpCode
//   returns the matched step, and the caller rejects any step at or below
//   the last accepted step (replay protection).
import { createHmac, randomBytes } from "node:crypto";

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1; // accept current step +/- 1

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode raw bytes as unpadded base32 (RFC 4648). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bitsLeft = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      out += BASE32_ALPHABET[(buffer >> bitsLeft) & 31];
    }
  }
  if (bitsLeft > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bitsLeft)) & 31];
  }
  return out;
}

/** Decode a base32 string (case-insensitive, padding tolerated) to bytes. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.trim().replace(/=+$/, "").toUpperCase();
  if (!/^[A-Z2-7]*$/.test(clean)) throw new Error("Invalid base32 secret.");
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** Generate a new TOTP secret (20 random bytes, base32-encoded). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The TOTP time step (number of 30s periods since the Unix epoch). */
export function totpTimeStep(now = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** Compute the 6-digit TOTP code for a secret at a given time step. */
export function totpCodeForStep(secret: string, step: number): string {
  const key = Buffer.from(base32Decode(secret));
  const counter = Buffer.alloc(8);
  // 64-bit big-endian counter.
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", key).update(counter).digest();
  // Dynamic truncation (RFC 4226 §5.4).
  const offset = hmac[hmac.length - 1] & 0x0f;
  const value =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(value % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a 6-digit TOTP code against a secret. Returns the matched time step
 * on success, or null when the code does not match any step in the window.
 * The caller must reject a step at or below the last accepted step (replay
 * protection) and must record the accepted step. `now` is injectable for
 * tests; production callers pass nothing.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  now = new Date()
): number | null {
  const clean = code.trim();
  if (!/^\d{6}$/.test(clean)) return null;
  let secretBytes: Uint8Array;
  try {
    secretBytes = base32Decode(secret);
  } catch {
    return null;
  }
  if (secretBytes.length === 0) return null;
  const current = totpTimeStep(now);
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step++) {
    if (step < 0) continue;
    if (totpCodeForStep(secret, step) === clean) return step;
  }
  return null;
}

/** Build the otpauth:// URL for a QR code / manual setup key. */
export function totpAuthUrl(input: { issuer: string; account: string; secret: string }): string {
  const label = `${input.issuer}:${input.account}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
