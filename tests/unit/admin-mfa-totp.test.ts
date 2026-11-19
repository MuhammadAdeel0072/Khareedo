// TOTP tests (PR-10). The implementation is verified against the RFC 6238
// test vectors (SHA1, secret "12345678901234567890" — base32
// GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ). The RFC vectors are 8-digit codes;
// the 6-digit code is the 8-digit code mod 10^6 (its last 6 digits).
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCodeForStep,
  totpTimeStep,
  verifyTotpCode,
} from "@/lib/totp";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 6238 SHA1 test vectors (6-digit form)", () => {
    // Time 59 -> counter 1 -> 8-digit 94287082 -> 6-digit 287082.
    expect(totpCodeForStep(RFC_SECRET, 1)).toBe("287082");
    // Time 1111111109 -> counter 37037036 -> 8-digit 07081804 -> 081804.
    expect(totpCodeForStep(RFC_SECRET, 37037036)).toBe("081804");
    // Time 1111111111 -> counter 37037037 -> 8-digit 14050471 -> 050471.
    expect(totpCodeForStep(RFC_SECRET, 37037037)).toBe("050471");
    // Time 1234567890 -> counter 41152263 -> 8-digit 89005924 -> 005924.
    expect(totpCodeForStep(RFC_SECRET, 41152263)).toBe("005924");
  });

  it("generates a 6-digit code for the current time step", () => {
    const now = new Date("2026-11-19T12:00:00.000Z");
    const code = totpCodeForStep(RFC_SECRET, totpTimeStep(now));
    expect(code).toMatch(/^\d{6}$/);
  });

  it("base32 round-trips the secret", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    // The RFC secret decodes to the ASCII bytes of "12345678901234567890".
    expect(Buffer.from(base32Decode(RFC_SECRET)).toString("ascii")).toBe("12345678901234567890");
  });

  it("generates a 32-char base32 secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it("accepts the current code and the adjacent steps (clock skew window)", () => {
    const now = new Date("2026-11-19T12:00:30.000Z");
    const step = totpTimeStep(now);
    const current = totpCodeForStep(RFC_SECRET, step);
    const previous = totpCodeForStep(RFC_SECRET, step - 1);
    const next = totpCodeForStep(RFC_SECRET, step + 1);
    expect(verifyTotpCode(RFC_SECRET, current, now)).toBe(step);
    expect(verifyTotpCode(RFC_SECRET, previous, now)).toBe(step - 1);
    expect(verifyTotpCode(RFC_SECRET, next, now)).toBe(step + 1);
  });

  it("rejects codes outside the window (expired)", () => {
    const now = new Date("2026-11-19T12:00:30.000Z");
    const step = totpTimeStep(now);
    const tooOld = totpCodeForStep(RFC_SECRET, step - 2);
    const tooNew = totpCodeForStep(RFC_SECRET, step + 2);
    expect(verifyTotpCode(RFC_SECRET, tooOld, now)).toBeNull();
    expect(verifyTotpCode(RFC_SECRET, tooNew, now)).toBeNull();
  });

  it("rejects invalid codes", () => {
    const now = new Date("2026-11-19T12:00:30.000Z");
    expect(verifyTotpCode(RFC_SECRET, "000000", now)).toBeNull();
    expect(verifyTotpCode(RFC_SECRET, "12345", now)).toBeNull(); // too short
    expect(verifyTotpCode(RFC_SECRET, "1234567", now)).toBeNull(); // too long
    expect(verifyTotpCode(RFC_SECRET, "abcdef", now)).toBeNull(); // not digits
    expect(verifyTotpCode(RFC_SECRET, " 123456 ", now)).toBeNull(); // wrong code, whitespace trimmed then rejected
  });

  it("rejects an invalid secret", () => {
    const now = new Date("2026-11-19T12:00:30.000Z");
    expect(verifyTotpCode("not-base32!", "123456", now)).toBeNull();
    expect(verifyTotpCode("", "123456", now)).toBeNull();
  });
});
