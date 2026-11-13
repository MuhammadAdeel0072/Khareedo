# Authentication setup

## Google sign-in

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the server environment.
In Google Cloud Console, configure the authorized redirect URI to match the
deployment's `NEXTAUTH_URL`:

- Local development: `http://localhost:3000/api/auth/callback/google`
- Production: `https://<your-domain>/api/auth/callback/google`

Google identities are linked by the verified provider account ID, not by email
address. If an email/password account already uses a Google email, sign in with
that account instead; the application does not silently merge the identities.

## Email verification

Email/password registration requires an SMTP sender. Configure these server-only
variables:

- `SMTP_HOST`
- `SMTP_PORT` (usually `587` for STARTTLS or `465` for implicit TLS)
- `SMTP_SECURE` (`true` for implicit TLS, otherwise `false`)
- `SMTP_USER` and `SMTP_PASSWORD` (both set or both empty for trusted relay)
- `SMTP_FROM` (verified sender address)
- `NEXTAUTH_URL` (public site origin used to create verification links)

The application stores only a SHA-256 hash of each random, 32-byte verification
token. Links expire after 24 hours and are single-use. Opening a valid link
redeems it through NextAuth's email-verification credentials provider, which
marks the eligible customer verified in the same transaction that consumes the
token. NextAuth then issues its normal JWT session; verification does not create
a custom authentication cookie or store a plaintext password. Expired, replayed,
or ineligible tokens cannot establish a session.

The pending page displays the submitted address and can resend without asking
for it again. A directly opened pending page still offers an email field.
Resend responses do not disclose whether an account exists. Callback destinations
are restricted to local paths, with `/account` as the fallback. Configure SMTP
before enabling email/password registrations.

## Database update

`prisma/schema.prisma` adds `OAuthAccount` and `VerificationToken` tables.
`prisma/sqlite-auth-additions.sql` is a non-destructive, CREATE TABLE-only
proposal for the existing SQLite database. It has not been applied. Back up the
database and review the SQL before applying it during an approved maintenance
window. Do not run `prisma db push` or a reset against the recovered database.
