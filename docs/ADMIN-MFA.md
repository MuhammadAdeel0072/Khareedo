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
- **Stolen sessions.** MFA is verified per session, bound to the session's
  id (see "Session binding" below): the guard requires the verification
  to have happened after the session was issued AND in that same session,
  so each new login must verify MFA again. A session cookie stolen before
  MFA was verified does not grant admin access — and, since Phase 2, it
  cannot become valid when the victim verifies in their own session
  either, because the verification is recorded against the victim's
  session id, not the attacker's.
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
invalidation. Since PR-25, `session.iat` is the session's *original*
issuance time (the custom JWT encoder preserves it across refreshes), so
an MFA verification correctly lasts for the session's lifetime instead of
being undone by a token refresh.

### Session binding (Phase 2, M-4 fix)

The timestamp check alone did not bind a verification to a session: a
JWT stolen *before* the victim verified MFA became valid the moment the
victim verified in their own session, because the check only compared
one per-user timestamp. That hole is closed by binding the verification
to the session id:

- At sign-in, the JWT callback mints a `sid` claim (a random UUID,
  `src/lib/auth.ts`). A custom claim is used because NextAuth's encoder
  overwrites `jti` with a fresh UUID on every encode — a `jti`-based
  binding would silently break (see the Phase 2 reassessment). The
  `sid` survives re-encoding because PR-25's custom encoder preserves
  all claims.
- Verification and activation record `AdminMfa.lastVerifiedSessionId`
  (migration `20261119000004_admin_mfa_session_binding`, additive,
  nullable).
- The guard (`isMfaVerifiedForSession`, `src/lib/auth-guard.ts`) requires
  `lastVerifiedAt > session.iat` **and** `lastVerifiedSessionId ===
  session.sid`. It fails closed when any value is missing.
- Sessions created before this deploy carry no `sid`, so every admin
  re-verifies MFA once after signing in again (bounded by the 7-day
  session lifetime). A session with no `sid` that reaches the verify
  endpoint gets 401 `SESSION_REBIND_REQUIRED` ("sign out and sign in
  again") instead of a misleading "wrong code".
- The same-second edge case is closed as a side effect: two sessions
  created in the same second have different sids, so one session's
  verification can never cover the other.
- Disablement does not go through the session-verification path: it
  checks the submitted code as a fresh proof of possession
  (`consumeValidAdminMfaCode`), because the session is already verified
  there and the short-circuit would accept without checking the code.

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
- Replace: 5/15min per admin, 10/15min per IP.

Limits are fixed 15-minute windows: once a window expires the budget is
restored in full — there is no permanent lockout, and a 429 always
carries a `retryAfterSec` (≤ 900). A missing or invalid encryption key
never consumes the budget: setup, verify, activate, replace and disable
check `isAdminMfaConfigured()` before touching the limiter, so a
configuration failure returns 503 every time instead of burning attempts
and surfacing as a misleading 429 (Phase 3 fix; see
`tests/unit/admin-mfa-routes.test.ts`).

## Configuration — operator runbook

`ADMIN_MFA_ENCRYPTION_KEY` is required before the first admin enrolls.
Without it, admin MFA setup and verification return 503 and admins
cannot reach the admin panel (MFA is required). The key is **not** in
the repository and is different per environment — never copy one
environment's key to another, and never commit it.

### 1. Generate a key (one per environment)

On Windows (PowerShell) or Linux/macOS:

```powershell
openssl rand -base64 32
```

The output is 44 characters of base64 (ending in `=`). Verify it
decodes to exactly 32 bytes before using it:

```powershell
# PowerShell — must print 32
[Convert]::FromBase64String("<paste the key here>").Length
```

```bash
# Linux/macOS — must print 32
printf '%s' '<paste the key here>' | base64 -d | wc -c
```

A key that does not decode to exactly 32 bytes is treated as missing:
the server returns 503 for all MFA operations.

### 2. Set it on Windows (local development, `D:\Khareedo`)

Add one line to `D:\Khareedo\.env` (the file is gitignored — never
commit it, never paste the key into chat):

```
ADMIN_MFA_ENCRYPTION_KEY=<paste the generated key here>
```

Restart the dev server (`npm run dev`) so the new value is picked up.

### 3. Set it on production (Hostinger VPS)

Set the same variable in the production environment — the `.env` file
the systemd service (`deploy/khareedo.service`) loads, or the host's
environment for the app process — then restart the app service
(`systemctl restart khareedo`). Confirm the service is healthy with
`GET /api/health` and by signing in as an admin: the MFA setup page
must load instead of a 503. The production key must be generated
fresh (step 1); do **not** reuse the Windows dev key or any sandbox key.

### 4. Rotating the key — warning

> **Rotating `ADMIN_MFA_ENCRYPTION_KEY` makes every existing MFA secret
> undecryptable. There is no recovery except re-enrollment.**

After a rotation, every enrolled admin's stored TOTP secret fails to
decrypt, so verification and disablement both fail for them. The only
way back is the break-glass procedure below (operator deletes the
`AdminMfa` row from the database) followed by fresh enrollment. Plan a
rotation like a maintenance event: warn all admins first, rotate, then
walk each admin through break-glass + re-enrollment. Do not rotate the
key casually, and never rotate it to "fix" a forgotten key — if the
current key is lost, the enrolled secrets are already unrecoverable and
the same break-glass + re-enrollment path applies.

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
- `tests/unit/admin-mfa-service.test.ts` (28): key loading/validation,
  `isAdminMfaConfigured()`, secret encryption + tamper detection, recovery-code format/hashing,
  status, enrollment (encrypted storage, QR + key), enrollment failing
  closed without the key, activation (valid/invalid/replayed first code,
  rollback on recovery-code failure, session binding), session
  verification (valid/replayed TOTP, recovery-code single use,
  unknown code, not-enrolled, fails closed without a sid, records the
  session id), regeneration (old codes invalidated),
  disablement (correct/wrong password, wrong code).
- `tests/unit/admin-mfa-guard.test.ts` (12): `isMfaVerifiedForSession`
  (before/after/at the session issued-at, missing values, verification in
  a different session, legacy session without a sid, same-second session),
  `requireAdminMfaVerified` (verified admin passes, unenrolled → 403
  MFA_ENROLLMENT_REQUIRED, enrolled-but-not-activated → 403, enabled-but-
  unverified → 401 MFA_VERIFICATION_REQUIRED, customer → 403 admin-only,
  unauthenticated → 401).
- `tests/unit/admin-mfa-routes.test.ts` (19): the limiter-ordering fix —
  a missing key returns 503 on repeated attempts without consuming any
  rate-limit budget (setup/verify/activate/replace/disable), real
  attempts are still limited (setup 3 then 429, verify/activate 5 then
  429), the 15-minute window restores the budget (no permanent lockout),
  invalid TOTP codes, `SESSION_REBIND_REQUIRED` for sessions without a
  sid, unauthenticated callers (401), recovery-code verification, and
  activation returning the recovery codes.
- `tests/unit/integration.admin-mfa.test.ts` (17): full lifecycle against
  the disposable SQLite DB — enroll, activate, verify, replay rejection,
  recovery-code single use, regeneration, disablement; activation with an
  invalid first code leaves MFA disabled; session binding (verification
  in one session does not verify another, no-sid verification fails
  closed, activation binds the activating session).

## Limitations

- **Same-second session edge case — closed in Phase 2.** The guard used
  to compare `lastVerifiedAt` (millisecond timestamp) against the
  session's issued-at time (`session.iat`, second granularity), so a new
  session created in the exact same second as a verification was
  considered verified. The session-id binding (above) closes this: two
  sessions created in the same second have different sids.
- **In-memory rate limiting.** MFA rate limits use the same in-memory
  limiter as the rest of the app. They do not share state across instances
  (see PR-11, shared rate limiting, deferred until Q-01/Q-02 resolve).
  Per-IP limiting relies on forwarded headers only when a trusted proxy
  is configured (`TRUSTED_PROXY_IPS`); otherwise all clients share one
  bucket (see `docs/DEPLOYMENT.md`).
- **No TOTP backup / multiple devices.** An admin has one active TOTP
  secret. Re-enrollment replaces it. Recovery codes are the only fallback.
- **Key rotation requires re-enrollment.** Rotating
  `ADMIN_MFA_ENCRYPTION_KEY` makes existing secrets undecryptable.
- **Admins who never enroll cannot reach the panel.** This is the intended
  enforcement (MFA is required for admins), but it means the first admin
  to sign in after deployment must complete setup. The break-glass
  procedure above covers a lost authenticator.
- **NextAuth v4 JWTs are not revocable.** MFA verification is bound to the
  session via `lastVerifiedAt` vs `session.iat` **and** the session id
  (`lastVerifiedSessionId` vs `session.sid`); a stolen session cookie
  from *after* MFA was verified is usable until the 7-day JWT expires
  (the same as any session-based auth). A stolen cookie from *before*
  verification is not usable, and cannot become usable when the victim
  verifies — the binding is per session.
