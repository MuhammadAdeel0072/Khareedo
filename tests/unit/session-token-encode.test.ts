// Session-token encoding tests (PR-25, H-C).
//
// The vulnerability: NextAuth v4's default `jwt.encode` stamps a fresh
// `iat`/`exp`/`jti` on every encode, so `GET /api/auth/session` re-issued
// a stolen token with fresh timestamps and a password reset could not kill
// it. The fix (`encodeSessionToken` in `src/lib/session-token.ts`) preserves
// the original `iat`/`exp`/`jti` when re-encoding an existing token.
//
// Every test decodes with NextAuth's own `decode` from `next-auth/jwt`,
// which proves the custom encoding is byte-compatible with the library:
// tokens produced here decrypt with the stock decoder, and tokens produced
// by the stock encoder re-encode here without changing their claims.
import { describe, expect, it } from "vitest";
import { decode, encode as defaultEncode } from "next-auth/jwt";
import { encodeSessionToken } from "@/lib/session-token";

const SECRET = "test-secret-for-session-token-encoding-only";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days, matches authOptions

describe("default next-auth encode (the vulnerable behaviour, H-C)", () => {
  it("refreshes iat and exp when re-encoding an existing token", async () => {
    const originalIat = Math.floor(Date.now() / 1000) - 3600;
    const originalExp = originalIat + MAX_AGE;
    const token = {
      sub: "user-1",
      role: "CUSTOMER",
      iat: originalIat,
      exp: originalExp,
      jti: "original-jti",
    };

    const encoded = await defaultEncode({ token, secret: SECRET, maxAge: MAX_AGE });
    const decoded = await decode({ token: encoded, secret: SECRET });

    // The default encode stamps fresh timestamps: this is the hole the
    // fix closes. If this assertion ever starts failing, the library
    // changed and the fix may no longer be needed.
    expect(decoded?.iat).toBeGreaterThan(originalIat);
    expect(decoded?.exp).toBeGreaterThan(originalExp);
  });
});

describe("encodeSessionToken (PR-25 fix)", () => {
  it("stamps fresh iat/exp/jti for a brand-new token", async () => {
    const before = Math.floor(Date.now() / 1000);

    const encoded = await encodeSessionToken({
      token: { sub: "user-1", role: "CUSTOMER" },
      secret: SECRET,
      maxAge: MAX_AGE,
    });
    const decoded = await decode({ token: encoded, secret: SECRET });

    expect(decoded?.sub).toBe("user-1");
    expect(decoded?.role).toBe("CUSTOMER");
    expect(decoded?.iat).toBeGreaterThanOrEqual(before);
    expect(decoded?.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(decoded?.exp).toBe((decoded?.iat as number) + MAX_AGE);
    expect(typeof decoded?.jti).toBe("string");
    expect((decoded?.jti as string).length).toBeGreaterThan(0);
  });

  it("preserves the original iat/exp/jti when re-encoding an existing token", async () => {
    const originalIat = Math.floor(Date.now() / 1000) - 3600;
    const originalExp = originalIat + MAX_AGE;
    const token = {
      sub: "user-1",
      role: "CUSTOMER",
      iat: originalIat,
      exp: originalExp,
      jti: "original-jti",
    };

    const encoded = await encodeSessionToken({ token, secret: SECRET, maxAge: MAX_AGE });
    const decoded = await decode({ token: encoded, secret: SECRET });

    expect(decoded?.iat).toBe(originalIat);
    expect(decoded?.exp).toBe(originalExp);
    expect(decoded?.jti).toBe("original-jti");
    expect(decoded?.sub).toBe("user-1");
  });

  it("round-trips a token encoded by the default encode, preserving its timestamps", async () => {
    // Simulates a real session: first encoded by the default encoder at
    // sign-in, then re-encoded by the fix on a session-route refresh.
    const first = await defaultEncode({
      token: { sub: "user-1", role: "CUSTOMER" },
      secret: SECRET,
      maxAge: MAX_AGE,
    });
    const firstDecoded = await decode({ token: first, secret: SECRET });

    const second = await encodeSessionToken({
      token: firstDecoded as Record<string, unknown>,
      secret: SECRET,
      maxAge: MAX_AGE,
    });
    const secondDecoded = await decode({ token: second, secret: SECRET });

    expect(secondDecoded?.iat).toBe(firstDecoded?.iat);
    expect(secondDecoded?.exp).toBe(firstDecoded?.exp);
    expect(secondDecoded?.jti).toBe(firstDecoded?.jti);
    expect(secondDecoded?.sub).toBe("user-1");
  });

  it("does not extend an already-expired token", async () => {
    const expiredIat = Math.floor(Date.now() / 1000) - MAX_AGE - 3600;
    const expiredExp = expiredIat + MAX_AGE; // already in the past
    const token = {
      sub: "user-1",
      iat: expiredIat,
      exp: expiredExp,
      jti: "expired-jti",
    };

    const encoded = await encodeSessionToken({ token, secret: SECRET, maxAge: MAX_AGE });

    // Decoding must reject the expired token: the fix never extends `exp`.
    await expect(decode({ token: encoded, secret: SECRET })).rejects.toThrow();
  });

  it("produces tokens a different secret cannot decode", async () => {
    const encoded = await encodeSessionToken({
      token: { sub: "user-1" },
      secret: SECRET,
      maxAge: MAX_AGE,
    });

    await expect(
      decode({ token: encoded, secret: "a-completely-different-secret" })
    ).rejects.toThrow();
  });
});
