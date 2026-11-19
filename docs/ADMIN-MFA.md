# Administrator MFA (PR-10)

TOTP-based multi-factor authentication for administrator accounts. A
password alone is no longer enough to reach the admin panel or any admin
API route: after signing in, an admin must also present a 6-digit code
from an authenticator app (Google Authenticator, Microsoft Authenticator,
Authy) or a one-time recovery code.

## What it protects

- **Stolen passwords.** An attacker with an admin's password but without
  their authenticator (or a recovery code) cannot reach the admin panel or
  any admin API route.
- **Stolen sessions.** MFA is verified per session: the guard requires the
  verification to have happened after the session was issued, so each new
  login must verify MFA again. A session cookie stolen before MFA was
  verified does not grant admin access.
- **Replayed codes.** A TOTP code is accepted only for a time step strictly
  greater than the last accepted step, so a code cannot be reused within
  its 30-second window — even concurrently, because the step claim is an
  atomic conditional update.
- **Brute force.** MFA verification, activation, enrollment, disablement,
  and recovery-code regeneration are rate-limited per admin and per IP.

Customer accounts are never subject to MFA. The customer login, checkout,
orders, and Safepay flows are unchanged.

## How it works

### Enrollment and activation

1. An admin signs in with their password and is redirected to
   `/admin/mfa/setup` (MFA is required for admins).
2. The admin starts enrollment: the server generates a fresh 20-byte TOTP
   secret, encrypts it (AES-256-GCM, see below), stores it, and returns a
   QR code plus the manual setup key. MFA is **not** enabled yet.
3. The admin scans the QR code (or enters the key) in their authenticator
   app and enters the first 6-digit code. The server verifies it and, on
   success, enables MFA and returns 10 recovery codes. The codes are shown
   **once**; the admin must confirm they saved them before continuing.

Re-enrollment is first-time only. Starting setup again while MFA is
already enabled is refused (403, `MFA_ALREADY_ENABLED`): a password-only
session must never be able to replace an active enrollment (P1 fix — a
stolen admin password alone could previously take over MFA by
re-enrolling). To change authenticators, an admin uses the replacement
flow below.

The enrollment write is TOCTOU-safe: it replaces a pending enrollment
only via a conditional update guarded on `enabledAt: null`, so a
concurrent activation that enabled MFA between the check and the write
cannot be overwritten (the update matches zero rows and enrollment is
refused). A fresh row is created only when no row exists. Enrollment
never deletes recovery codes: a pending (never-enabled) enrollment
cannot legitimately have any — codes are only created at activation — so
deleting from this path could destroy codes issued by a concurrent
successful activation.

Activation is atomic: enabling MFA and issuing the recovery-code hashes
happen in a single database transaction, so they succeed or fail
together. A database failure while issuing codes rolls the enablement
back — MFA is never left enabled without its recovery codes. Likewise,
activation only succeeds while the secret it verified is still the stored
secret (a secret-equality guard on the conditional update), so a
concurrent enrollment cannot leave MFA enabled with a secret the admin
never set up. The replacement swap is equally atomic: the secret swap,
the deletion of the old codes, and the issuing of fresh codes are one
transaction, so a failed code creation rolls the swap back and the old
secret and codes stay active. Recovery-code regeneration is atomic the
same way (delete and create in one transaction).

### Replacing an authenticator (active MFA)

1. The admin is signed in with an MFA-verified session and opens
   `/admin/mfa/setup` → "Replace authenticator".
2. The admin enters their current password AND a code from the current
   authenticator (or a recovery code). The server verifies both
   (`POST /api/admin/mfa/replace`, `requireAdminMfaVerified` + fresh
   reauthentication).
3. On success the server generates a new secret and stores it as a
   **pending** replacement (`pendingSecretEncrypted`); the active secret,
   `enabledAt`, `lastVerifiedAt`, and recovery codes are all preserved.
   The new QR code and manual key are returned.
4. The admin scans the new QR code and verifies a code from the new
   authenticator (`POST /api/admin/mfa/activate`). Success atomically
   swaps the pending secret into place (in a transaction with the
   recovery-code rotation), keeps MFA enabled, and invalidates the old
   recovery codes, issuing a fresh set shown once.
5. A failed or abandoned replacement changes nothing: the active secret
   and recovery codes keep working, and the pending secret is simply
   ignored (starting another replacement overwrites it).

Activating an already-active MFA with no pending replacement returns
400: activation must not regenerate recovery codes on an active
enrollment, which would bypass the `requireAdminMfaVerified` gate of the
recovery-codes endpoint.

### Login with MFA

1. The admin signs in with email + password (existing NextAuth flow).
2. If MFA is enabled and this session has not verified it, the admin is
   redirected to `/admin/mfa/verify`.
3. The admin enters a 6-digit authenticator code or a recovery code.
   On success the session is MFA-verified and the admin reaches the panel.
   A recovery code is single-use and is consumed on success.

### Enforcement

`requireAdminMfaVerified()` (in `src/lib/auth-guard.ts`) is the
enforcement point, used by the admin panel layout and by all admin API
routes. It throws `MfaRequiredError` with a machine-readable code:

- `MFA_ENROLLMENT_REQUIRED` (403): the admin has not enabled MFA yet.
- `MFA_VERIFICATION_REQUIRED` (401): MFA is enabled but this session has
  not verified it yet.

The MFA setup/verify pages and their API routes use `requireAdmin()` (role
only, no MFA check) so an admin can enroll or verify. The proxy still
protects `/admin/*` by role at the edge; MFA is enforced server-side in
the guard (defence in depth).

The guard re-reads MFA state from the database on every request, alongside
the role and `passwordChangedAt` (PR-09). It requires `lastVerifiedAt` to
be after the session's issued-at time (`session.iat`), so each new login
must verify MFA again — the same pattern as PR-09's password-change
invalidation.

### TOTP

Implemented from scratch on Node's built-in `crypto` (no TOTP dependency)
and verified against the RFC 6238 test vectors in
`tests/unit/admin-mfa-totp.test.ts`:

- HMAC-SHA1, 6 digits, 30-second period (the authenticator-app default).
- Verification window: the current step ± 1 step (90 seconds total), to
  allow for clock skew between the server and the admin's phone.
- The otpauth:// URL (`otpauth://totp/Khareedo:<email>?secret=...&issuer=Khareedo&algorithm=SHA1&digits=6&period=30`)
  is rendered as a QR code (the `qrcode` package) and the base32 secret is
  shown as the manual setup key.

### Secrets at rest

The TOTP secret is stored AES-256-GCM encrypted. The key comes from
`ADMIN_MFA_ENCRYPTION_KEY` (32 random bytes, base64 — generate with
`openssl rand -base64 32`). If the key is missing or invalid, MFA
enrollment and verification fail closed (503); nothing is stored or
verified in plaintext. The encrypted layout is IV (12 bytes) || auth tag
(16 bytes) || ciphertext, stored as `Bytes`.

**Rotating the key** makes existing MFA secrets undecryptable, so enrolled
admins must re-enroll after a rotation. Do not rotate the key casually.

Recovery codes are stored as SHA-256 hashes only. The raw code is shown
to the admin once at generation and never persisted or logged. A code is
single-use: redemption sets `usedAt` atomically (guarded by `usedAt`
null). Regeneration deletes all previous codes (used and unused) and
returns a fresh set.

### Disablement

Disabling MFA requires reauthentication: the admin's current password AND
a valid TOTP code or recovery code. A failed password or code leaves MFA
untouched. Disablement deletes the secret and all recovery codes.

### Rate limiting

All MFA endpoints are rate-limited per admin and per IP (in-memory, same
caveat as the rest of the app: per-IP limiting is not robust across
multiple instances; see the limitations below):

- Setup: 3/15min per admin, 5/15min per IP.
- Activate: 5/15min per admin, 10/15min per IP.
- Verify: 5/15min per admin, 10/15min per IP.
- Recovery-code regeneration: 3/15min per admin, 5/15min per IP.
- Disable: 3/15min per admin, 5/15min per IP.

## Configuration

Add to the environment (see `.env.example`):

```
ADMIN_MFA_ENCRYPTION_KEY="<32 random bytes, base64>"
```

Generate it with:

```
openssl rand -base64 32
```

Without this key, admin MFA setup and verification return 503 and admins
cannot reach the admin panel (MFA is required). Set it before the first
admin enrolls.

## Break-glass: an admin loses both authenticator and recovery codes

There is deliberately no self-service MFA reset (that would be an
authentication bypass). If an admin loses their authenticator **and** all
recovery codes, an operator with database access must disable MFA for that
admin directly:

```sql
-- Find the admin's MFA row, then delete it (recovery codes cascade).
DELETE FROM "AdminMfa" WHERE "userId" = '<admin user id>';
```

After this, the admin signs in with their password and is redirected to
`/admin/mfa/setup` to enroll again with a new secret. Verify the admin's
identity out-of-band before doing this, and record the action in the
operator's runbook. (Append-only admin audit logging is PR-12; until then,
record break-glass resets in the operator's own log.)

## Files

- `src/lib/totp.ts` — TOTP (RFC 6238) + base32, from scratch on Node crypto.
- `src/services/admin-mfa.service.ts` — enrollment, activation,
  verification, recovery codes, disablement, AES-256-GCM secret encryption.
- `src/lib/auth-guard.ts` — `requireAdminMfaVerified()`,
  `isMfaVerifiedForSession()`, `MfaRequiredError`.
- `src/lib/api.ts` — `handleRoute` includes the MFA error code in the
  response so the frontend can redirect to setup or verify.
- `src/app/api/admin/mfa/` — `status` (GET), `setup`, `replace`, `activate`,
  `verify`, `recovery-codes`, `disable` (POST).
- `src/app/admin/mfa/setup/page.tsx`, `src/app/admin/mfa/verify/page.tsx`
  — MFA pages (outside the admin panel layout so they stay reachable).
- `src/components/admin/mfa-setup-form.tsx`,
  `src/components/admin/mfa-verify-form.tsx` — enrollment/verification UI.
- `src/app/admin/(panel)/layout.tsx` — redirects unenrolled admins to
  setup and unverified sessions to verify.
- `src/app/api/admin/*` (23 routes) — now use `requireAdminMfaVerified()`
  instead of `requireAdmin()`.
- `prisma/schema.postgres.prisma`, `prisma/schema.sqlite.prisma` —
  `AdminMfa` + `AdminMfaRecoveryCode` models, `User.adminMfa` relation.
- `prisma/migrations/20261119000002_admin_mfa/migration.sql` — additive,
  RLS enabled, no existing rows modified.

## Tests

- `tests/unit/admin-mfa-totp.test.ts` (8): RFC 6238 test vectors,
  6-digit codes, base32 round-trip, secret generation, the ±1-step window,
  expired codes, invalid codes/secrets.
- `tests/unit/admin-mfa-service.test.ts` (20): key loading/validation,
  secret encryption + tamper detection, recovery-code format/hashing,
  status, enrollment (encrypted storage, QR + key), enrollment failing
  closed without the key, activation (valid/invalid/replayed first code),
  session verification (valid/replayed TOTP, recovery-code single use,
  unknown code, not-enrolled), regeneration (old codes invalidated),
  disablement (correct/wrong password, wrong code).
- `tests/unit/admin-mfa-guard.test.ts` (8): `isMfaVerifiedForSession`
  (before/after/at the session issued-at, missing values),
  `requireAdminMfaVerified` (verified admin passes, unenrolled → 403
  MFA_ENROLLMENT_REQUIRED, enrolled-but-not-activated → 403, enabled-but-
  unverified → 401 MFA_VERIFICATION_REQUIRED, customer → 403 admin-only,
  unauthenticated → 401).
- `tests/unit/integration.admin-mfa.test.ts` (2): full lifecycle against
  the disposable SQLite DB — enroll, activate, verify, replay rejection,
  recovery-code single use, regeneration, disablement; activation with an
  invalid first code leaves MFA disabled.

## Limitations

- **Same-second session edge case.** The guard compares `lastVerifiedAt`
  (millisecond timestamp) against the session's issued-at time
  (`session.iat`, second granularity). If a new session is created in the
  exact same second an admin verifies MFA, it is considered verified
  without re-verifying. Exploiting this requires knowing the admin's
  password and timing a login to the exact second of their verification,
  which is not observable to an attacker — practically unexploitable, but
  a future hardening step is a per-session JWT id (`jti`) recorded at
  verification time.
- **In-memory rate limiting.** MFA rate limits use the same in-memory
  limiter as the rest of the app. They do not share state across instances
  (see PR-11, shared rate limiting, deferred until Q-01/Q-02 resolve).
  Per-IP limiting relies on X-Forwarded-For, which is client-controlled
  unless a trusted proxy overwrites it (same caveat as PR-05).
- **No TOTP backup / multiple devices.** An admin has one active TOTP
  secret. Re-enrollment replaces it. Recovery codes are the only fallback.
- **Key rotation requires re-enrollment.** Rotating
  `ADMIN_MFA_ENCRYPTION_KEY` makes existing secrets undecryptable.
- **Admins who never enroll cannot reach the panel.** This is the intended
  enforcement (MFA is required for admins), but it means the first admin
  to sign in after deployment must complete setup. The break-glass
  procedure above covers a lost authenticator.
- **NextAuth v4 JWTs are not revocable.** MFA verification is bound to the
  session via `lastVerifiedAt` vs `session.iat`; a stolen session cookie
  from *after* MFA was verified is usable until the 7-day JWT expires
  (the same as any session-based auth).
