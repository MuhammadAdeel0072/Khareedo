# Password Reset (PR-09)

Secure password recovery for customers and administrators. A locked-out
customer or admin can recover access without support intervention.

## Flow

1. The user opens **/forgot-password** (linked from the login page as
   "Forgot password?") and submits their email address.
2. `POST /api/auth/forgot-password` rate-limits the request and, if an
   eligible credentials account exists, issues a single-use token and emails
   a reset link (`/reset-password?token=...`). The response is identical
   whether or not an account exists, so the endpoint cannot be used to probe
   which emails are registered (enumeration-safe).
3. The user opens the link and submits a new password (min 8, max 72 chars,
   same `passwordSchema` as registration) to `POST /api/auth/reset-password`.
4. The token is redeemed atomically: it is marked consumed only if still
   unused and unexpired, and the password is changed in the same
   transaction. The token can never be reused.
5. The user signs in with the new password. The old password stops working
   immediately.

## Token design

Mirrors the email-verification token pattern
(`src/services/email-verification.service.ts`):

- Token: 32 cryptographically secure random bytes (`randomBytes(32)`),
  base64url-encoded.
- Only the **SHA-256 hash** is stored (`PasswordResetToken.tokenHash`,
  unique). The raw token is emailed once and never persisted or logged.
- **TTL: 1 hour** (`PASSWORD_RESET_TOKEN_TTL_MS`).
- **Single-use**: `consumedAt` is set atomically with an
  `updateMany({ where: { id, consumedAt: null, expiresAt: { gt: now } } })`
  guard, so concurrent redemptions only succeed once.
- **Separate table** from `VerificationToken`, so a verification token can
  never be redeemed as a reset token (and vice versa). Verified by an
  integration test.
- Issuing a new token deletes all previous reset tokens for that user, so
  only one valid token exists at a time.
- Only credentials accounts (`passwordHash` set) receive a token. OAuth-only
  accounts have no password to reset and receive nothing, silently.

## Session invalidation (the JWT design decision)

NextAuth v4 uses JWT sessions, and **JWTs are not revocable**. A password
reset therefore cannot invalidate existing sessions by deleting a server-side
record — there is none. Instead, a successful reset records
`User.passwordChangedAt`, and the auth guard (`src/lib/auth-guard.ts`)
rejects any session whose JWT was issued at or before that timestamp:

- `auth.ts` exposes the JWT issued-at time on the session (`session.iat`).
- The guard already re-fetches the user from the DB on every protected
  request (to re-verify the role), so the check adds no extra query: it
  reads `passwordChangedAt` from that same fetch and returns `null`
  (unauthenticated) when `passwordChangedAt >= iat`.
- The user must then sign in again with the new password. Sessions issued
  after the reset are unaffected.
- A session whose token carries no issued-at time (pre-PR-09) cannot be
  compared and stays valid until its own 7-day expiry; this only affects
  tokens issued before this change deployed.

## Rate limiting

- `POST /api/auth/forgot-password`: 10 requests / 15 min per IP, plus
  3 requests / hour per email address (SHA-256 hash of the email is the
  key, so the raw email is not stored in the limiter).
- `POST /api/auth/reset-password`: 10 attempts / 15 min per IP, to slow
  token guessing. Tokens are 32 random bytes, so guessing is infeasible;
  the limit is defence in depth.
- Limits are per-instance in-memory (same as the rest of the app's rate
  limiting; see PR-11 for the shared-store follow-up). A 429 response
  includes `retryAfterSec`.

## Email

`sendPasswordResetEmail` (in `src/services/email.service.ts`) mirrors
`sendVerificationEmail`: same SMTP configuration and pooled transporter,
HTML + plain-text bodies, 1-hour expiry stated in the message, and a note
that ignoring the email leaves the password unchanged. If SMTP is not
configured, the request endpoint returns 503 and no token is issued.

## What is NOT covered

- Password reset does not verify the email address: an account that never
  verified its email still cannot sign in with a password (the credentials
  provider requires `emailVerified`). Resetting the password for such an
  account is harmless — the reset email itself proves ownership of the
  address — but the user must still verify their email to sign in.
- There is no "change password while signed in" flow yet; that is a
  separate feature (the reset flow covers the locked-out case).

## Tests

- `tests/unit/password-reset.test.ts` (14): token hashing, TTL, usability,
  enumeration safety, OAuth-only accounts, single-use, expiry, reuse,
  weak-password rejection, admin reset.
- `tests/unit/password-reset-routes.test.ts` (11): uniform responses,
  422/503/429 behaviour, per-IP and per-email rate limiting.
- `tests/unit/auth-guard-password-change.test.ts` (5): the
  session-invalidation comparison (before/after/exact-moment, missing
  values).
- `tests/unit/integration.password-reset.test.ts` (3, via `test:db`):
  end-to-end reset against a disposable SQLite DB (password changes, old
  password fails, new password works, `passwordChangedAt` set, token
  consumed, reuse fails, verification token cannot reset a password,
  unknown email creates no token).
