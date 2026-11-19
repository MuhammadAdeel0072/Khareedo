// Session-token encoding for NextAuth v4 (PR-25).
//
// Problem (H-C): NextAuth v4's default `jwt.encode` unconditionally stamps
// a fresh `iat`, a fresh `exp` (now + maxAge) and a fresh `jti` on EVERY
// encode. `GET /api/auth/session` therefore re-issues the JWT with fresh
// timestamps, so a stolen token survived a password reset: the re-encode
// set `iat` to after `passwordChangedAt`, and the auth guard's
// `isSessionInvalidatedByPasswordChange()` stopped rejecting it. Repeating
// the refresh kept the session alive indefinitely.
//
// Fix: a custom `jwt.encode` (wired into `authOptions` in `src/lib/auth.ts`)
// that PRESERVES the original `iat`/`exp`/`jti` when re-encoding an
// existing token, and stamps fresh values only for a brand-new sign-in.
// The token's lifetime can therefore never be extended past its original
// expiry, and a password reset invalidates every session issued before it
// — including sessions refreshed through `/api/auth/session`.
//
// Compatibility: the output is a standard JWE (compact serialization,
// `alg: "dir"`, `enc: "A256GCM"`) using the exact key derivation NextAuth
// uses (HKDF-SHA256, info `NextAuth.js Generated Encryption Key`), so
// tokens produced here are decrypted by NextAuth's default `jwt.decode`,
// and tokens produced by the default encode are re-encoded here without
// changing their claims. Only Node's built-in `crypto` is used — no new
// dependency. Verified by round-trip tests against `next-auth/jwt`
// (`tests/unit/session-token-encode.test.ts`).
import {
  createCipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";

const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60; // 30 days (NextAuth's default)

/** Base64url-encode a buffer or UTF-8 string. */
function base64url(input: Buffer | string): string {
  const buffer =
    typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64url");
}

/**
 * Derive the JWE content-encryption key exactly the way NextAuth does
 * (`getDerivedEncryptionKey` in `next-auth/jwt`): HKDF-SHA256 over the
 * secret, with info `NextAuth.js Generated Encryption Key` (plus
 * ` (<salt>)` when a salt is set), 32 bytes out. Node's `hkdfSync`
 * produces byte-identical output to the `@panva/hkdf` package NextAuth
 * uses — proven by the round-trip tests, which decrypt tokens produced
 * here with NextAuth's own `decode`.
 */
function deriveEncryptionKey(secret: string | Buffer, salt: string): Buffer {
  const info = `NextAuth.js Generated Encryption Key${
    salt ? ` (${salt})` : ""
  }`;
  return Buffer.from(hkdfSync("sha256", secret, salt, info, 32));
}

/**
 * Encode a session token as a JWE, preserving the original `iat`, `exp`
 * and `jti` when the token already carries them. Fresh values are stamped
 * only when a claim is absent (a brand-new sign-in). The `exp` is never
 * extended: a re-encoded token keeps the expiry it was first issued with,
 * so refreshing a session cannot outlive a password reset.
 *
 * Signature matches NextAuth v4's `JWT.encode` params so it can be wired
 * straight into `authOptions.jwt.encode`. `decode` is intentionally left
 * as NextAuth's default — it already decrypts these tokens.
 */
export async function encodeSessionToken(params: {
  token?: Record<string, unknown>;
  // NextAuth types this as `string | Buffer`; both are accepted here and
  // passed straight to the HKDF, which takes either as key material.
  secret: string | Buffer;
  maxAge?: number;
  salt?: string;
}): Promise<string> {
  const { token = {}, secret, maxAge = DEFAULT_MAX_AGE, salt = "" } = params;
  const encryptionKey = deriveEncryptionKey(secret, salt);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = { ...token };
  if (typeof payload.iat !== "number") payload.iat = nowSeconds;
  if (typeof payload.exp !== "number") payload.exp = nowSeconds + maxAge;
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    payload.jti = randomUUID();
  }

  const encodedHeader = base64url(
    JSON.stringify({ alg: "dir", enc: "A256GCM" })
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  // The AAD is the ASCII bytes of the encoded protected header (RFC 7516).
  cipher.setAAD(Buffer.from(encodedHeader, "ascii"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // JWE compact serialization. `alg: "dir"` means the key is used
  // directly, so the encrypted-key segment is empty.
  return [
    encodedHeader,
    "",
    base64url(iv),
    base64url(ciphertext),
    base64url(authTag),
  ].join(".");
}
