// Auth guard: session invalidation after a password change (PR-09).
//
// NextAuth v4 JWTs are not revocable, so a password reset records
// passwordChangedAt and the guard rejects any session issued at or before
// that moment. This tests the pure comparison helper directly.
import { describe, expect, it } from "vitest";
import { isSessionInvalidatedByPasswordChange } from "@/lib/auth-guard";

describe("isSessionInvalidatedByPasswordChange", () => {
  // Token issued at 2026-11-19 12:00:00 UTC (seconds since epoch).
  const iat = Math.floor(new Date("2026-11-19T12:00:00Z").getTime() / 1000);

  it("invalidates a session issued before the password change", () => {
    expect(
      isSessionInvalidatedByPasswordChange(new Date("2026-11-19T12:00:01Z"), iat)
    ).toBe(true);
  });

  it("invalidates a session issued at the exact moment of the change", () => {
    expect(
      isSessionInvalidatedByPasswordChange(new Date("2026-11-19T12:00:00Z"), iat)
    ).toBe(true);
  });

  it("keeps a session issued after the password change", () => {
    expect(
      isSessionInvalidatedByPasswordChange(new Date("2026-11-19T11:59:59Z"), iat)
    ).toBe(false);
  });

  it("keeps the session when no password change is recorded", () => {
    expect(isSessionInvalidatedByPasswordChange(null, iat)).toBe(false);
  });

  it("keeps the session when the token carries no issued-at time", () => {
    expect(
      isSessionInvalidatedByPasswordChange(new Date("2026-11-19T12:00:01Z"), undefined)
    ).toBe(false);
  });
});
