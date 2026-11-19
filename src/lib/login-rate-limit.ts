// Failed-login rate limiting (Phase 2, area A — H-A).
//
// The credentials login had no rate limiting at all: unlimited password
// guessing / credential stuffing against customer AND admin accounts, with
// each guess costing a bcrypt.compare (a CPU-exhaustion DoS on top of the
// guessing). MFA does not help — the verify endpoint is only reachable
// after the password succeeds.
//
// Dual-key, failures-only limiting, on the existing in-memory limiter:
// - per-IP: 10 failed attempts / 15 min (bounds guessing from one source).
// - per-normalized-email-hash: 5 failed attempts / 15 min (bounds guessing
//   against one account even when the attacker rotates IPs; the key is a
//   SHA-256 hash so the limiter never stores a raw email).
//
// Only FAILED attempts consume a slot: the budget is checked (without
// consuming) before the database lookup and bcrypt, and a slot is recorded
// only when the attempt actually fails. Successful sign-ins never consume.
// When either bucket is exhausted, `authorize` throws an Error whose
// message is the `LOGIN_RATE_LIMIT_ERROR` code; NextAuth surfaces it as
// `?error=TooManyLoginAttempts` and the login form shows a specific
// message. The generic wrong-password response is unchanged for ordinary
// failures, so the limiter adds no enumeration oracle.
//
// Trade-off (documented, not hidden): the per-email bucket lets an
// attacker lock a specific victim's email out for up to 15 minutes by
// failing 5 logins. That is the price of stopping credential stuffing
// against one account from many IPs; the window is short and the limit
// counts failures only. A durable per-email store (shared across
// instances) needs the shared rate-limit store (PR-11, blocked on Q-01 /
// Q-02); until then this is per-instance, like every other limit here.
import { createHash } from "node:crypto";
import { checkRateLimit, rateLimit } from "@/lib/rate-limit";

/** Error code thrown by `authorize` when the login budget is exhausted. */
export const LOGIN_RATE_LIMIT_ERROR = "TooManyLoginAttempts";

/** Failed-login budget: 10 attempts per IP per 15 minutes. */
export const LOGIN_IP_LIMIT = 10;
/** Failed-login budget: 5 attempts per email hash per 15 minutes. */
export const LOGIN_EMAIL_LIMIT = 5;
/** Window for both login budgets. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** SHA-256 of the normalized email — the limiter never stores raw emails. */
export function hashLoginEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function ipKey(ip: string): string {
  return `login-fail-ip:${ip}`;
}

function emailKey(emailHash: string): string {
  return `login-fail-email:${emailHash}`;
}

/**
 * Non-consuming check: is either login bucket exhausted for this IP /
 * email hash? Call before the database lookup and bcrypt so a locked-out
 * attempt fails fast without burning a bcrypt.compare.
 */
export function isLoginRateLimited(
  ip: string,
  emailHash: string
): { limited: boolean; retryAfterSec: number } {
  const ipCheck = checkRateLimit(ipKey(ip), LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
  if (!ipCheck.ok) return { limited: true, retryAfterSec: ipCheck.retryAfterSec };
  const emailCheck = checkRateLimit(emailKey(emailHash), LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_MS);
  if (!emailCheck.ok) return { limited: true, retryAfterSec: emailCheck.retryAfterSec };
  return { limited: false, retryAfterSec: 0 };
}

/** Record one failed login attempt against both buckets. */
export function recordLoginFailure(ip: string, emailHash: string): void {
  rateLimit(ipKey(ip), LOGIN_IP_LIMIT, LOGIN_WINDOW_MS);
  rateLimit(emailKey(emailHash), LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_MS);
}
