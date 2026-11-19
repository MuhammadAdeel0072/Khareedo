// Tests for login brute-force protection (Phase 2, area A — H-A).
//
// The limiter is failures-only and dual-key: a per-IP bucket and a
// per-normalized-email-hash bucket. Only failed attempts consume a slot,
// so legitimate sign-ins are never throttled, and the email hash (never
// the raw address) is the only per-account key the limiter stores.
import { describe, expect, it } from "vitest";
import {
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_RATE_LIMIT_ERROR,
  LOGIN_WINDOW_MS,
  hashLoginEmail,
  isLoginRateLimited,
  recordLoginFailure,
} from "@/lib/login-rate-limit";
import { checkRateLimit, rateLimit } from "@/lib/rate-limit";

const TEST_IP = "203.0.113.50";
const TEST_EMAIL = "victim@example.com";

describe("hashLoginEmail", () => {
  it("normalizes case and whitespace before hashing", () => {
    expect(hashLoginEmail("  Victim@Example.COM ")).toBe(hashLoginEmail("victim@example.com"));
    expect(hashLoginEmail(TEST_EMAIL)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashLoginEmail(TEST_EMAIL)).not.toContain("victim");
  });
});

describe("login rate limiting (helpers)", () => {
  it("allows attempts inside the budget and blocks at the email limit", () => {
    const emailHash = hashLoginEmail(`budget-${Date.now()}@example.invalid`);
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      expect(isLoginRateLimited(TEST_IP, emailHash).limited).toBe(false);
      recordLoginFailure(TEST_IP, emailHash);
    }
    const blocked = isLoginRateLimited(TEST_IP, emailHash);
    expect(blocked.limited).toBe(true);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(Math.ceil(LOGIN_WINDOW_MS / 1000));
  });

  it("blocks at the IP limit even for different email addresses", () => {
    // Credential stuffing rotates the email; the per-IP bucket is the
    // backstop. Use a fresh IP so earlier tests cannot interfere.
    const ip = `203.0.113.${100 + Math.floor(Math.random() * 100)}`;
    for (let i = 0; i < LOGIN_IP_LIMIT; i++) {
      const emailHash = hashLoginEmail(`stuffing-${Date.now()}-${i}@example.invalid`);
      expect(isLoginRateLimited(ip, emailHash).limited).toBe(false);
      recordLoginFailure(ip, emailHash);
    }
    expect(isLoginRateLimited(ip, hashLoginEmail("another@example.invalid")).limited).toBe(true);
  });

  it("checks without consuming (isLoginRateLimited is a peek)", () => {
    const emailHash = hashLoginEmail(`peek-${Date.now()}@example.invalid`);
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      expect(isLoginRateLimited(TEST_IP, emailHash).limited).toBe(false);
    }
    // No failures were recorded, so the budget is still full.
    expect(isLoginRateLimited(TEST_IP, emailHash).limited).toBe(false);
    expect(checkRateLimit(`login-fail-email:${emailHash}`, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_MS).ok).toBe(true);
  });

  it("exposes the error string the login form maps to a message", () => {
    expect(LOGIN_RATE_LIMIT_ERROR).toBe("TooManyLoginAttempts");
    expect(rateLimit).toBeDefined();
  });
});
