import { describe, expect, it } from "vitest";
import { safeCallbackUrl } from "@/lib/auth-client";
import {
  hashVerificationToken,
  isVerificationTokenUsable,
  verifyEmailToken,
} from "@/services/email-verification.service";

describe("safe authentication callback URLs", () => {
  it("preserves safe local paths and query strings", () => {
    expect(safeCallbackUrl("/account/orders?page=2")).toBe("/account/orders?page=2");
  });

  it("rejects external and protocol-relative redirect targets", () => {
    expect(safeCallbackUrl("https://attacker.example/")).toBe("/account");
    expect(safeCallbackUrl("//attacker.example/")).toBe("/account");
  });
});

describe("email verification tokens", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("hashes tokens deterministically without storing the raw value", () => {
    expect(hashVerificationToken("one-time-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashVerificationToken("one-time-token")).toBe(hashVerificationToken("one-time-token"));
  });

  it("rejects expired and previously consumed tokens", () => {
    expect(
      isVerificationTokenUsable({
        expiresAt: new Date(now.getTime() - 1),
        consumedAt: null,
      }, now)
    ).toBe(false);
    expect(
      isVerificationTokenUsable({
        expiresAt: new Date(now.getTime() + 1),
        consumedAt: now,
      }, now)
    ).toBe(false);
  });

  it("rejects absent or oversized tokens before database access", async () => {
    await expect(verifyEmailToken("")).resolves.toBe(false);
    await expect(verifyEmailToken("x".repeat(257))).resolves.toBe(false);
  });
});
