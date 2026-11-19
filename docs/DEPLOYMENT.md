# Deployment (what actually runs, and what does not)

This is the deployment model as evidenced in the repository. Anything not
listed here is unverified — do not assume it.

## Build and start

- `npm run build` generates the PostgreSQL Prisma client
  (`npm run db:generate:postgres`) and produces a Next.js **standalone**
  build (`output: "standalone"` in `next.config.ts`).
- The production server is started with
  `bun .next/standalone/server.js` (the `start` script). Bun is the
  **runtime** here, not the package manager — dependencies are installed
  with `npm` only (`package-lock.json` is the only lockfile; see
  `docs/PRISMA.md`).
- The standalone build omits `.env`, so runtime secrets must be injected
  through the deployment platform. The database CA certificate (when
  `SUPABASE_DB_CA_CERT` is set) must be present at its configured path.
- `next.config.ts` also serves the security headers (report-only CSP) and,
  only when `LOCAL_STORAGE_PROXY_URL` is set, a storage proxy for
  sandbox/CI previews. That proxy is unset in production.

## Database

- Supabase PostgreSQL is the application database
  (`SUPABASE_POSTGRES_URL`, server-side only). SQLite is test-only.
- Schema changes reach Supabase **only** through the reviewed Prisma
  migrations in `prisma/migrations/`, applied with
  `npm run db:postgres:deploy` (`prisma migrate deploy`, with its own
  project-target check). See `docs/DATABASE-MIGRATION.md` and
  `docs/SQL-SAFETY.md`. Never run `db:push`, `migrate dev`, or `migrate
  reset` against the application database — those go through the guarded
  wrapper and refuse anything but a local `file:` target.
- Rollback is redeploying the previous release against the same
  PostgreSQL database (see `docs/DATABASE-MIGRATION.md`). There is no
  production SQLite fallback.

## Runtime assumptions

- **Single instance.** The payment-maintenance worker is in-process
  (`src/instrumentation.ts`) and rate limiting is in-memory, so each
  instance reports its own worker state and enforces its own limits. A
  multi-instance or serverless deployment needs a shared store for the
  worker and the limiter, and should call
  `POST /api/admin/payments/maintenance` on a schedule instead of relying
  on the in-process worker (set `PAYMENT_MAINTENANCE_WORKER=off` there).
- Health is exposed at `GET /api/health` (public, no-store). Errors are
  captured centrally and, when configured, emailed (see
  `docs/ERROR-MONITORING.md`).
- CI is the `Khareedo CI` workflow (`.github/workflows/ci.yml`): `npm ci`,
  both Prisma clients, typecheck, lint, `test:db`, production build.

## Production security configuration (Phase 2)

Complete these once the hosting environment is chosen (Q-01). Until
then the app runs in its fail-safe posture: secure by default, with
per-IP features degraded rather than spoofable.

- **HTTPS + `NEXTAUTH_URL`.** Production must be HTTPS with `NEXTAUTH_URL`
  set to the production `https://` origin. Without it the session cookie
  is served without `Secure` and NextAuth derives the origin from request
  headers; the app logs a loud warning at startup. A non-localhost
  `http://` `NEXTAUTH_URL` in production fails fast at startup. See
  `src/lib/auth.ts` and `src/lib/site-url.ts`.
- **`NEXTAUTH_SECRET` ≥ 32 characters** (`openssl rand -base64 32`). A
  shorter secret works but logs a loud `SECURITY` warning at startup.
  The CI build step still uses an 18-character dummy — lengthen it in
  `ci.yml` (a one-line change; the GitHub App cannot edit workflows, so
  the operator applies it).
- **Trusted proxy — `TRUSTED_PROXY_IPS`.** Comma-separated list of the
  production proxy's IPs. The proxy **must overwrite** `X-Forwarded-For`,
  `X-Real-IP`, `X-Forwarded-Host` and `X-Forwarded-Proto` (not append to
  them — the Caddyfile does overwrite them, if it is the proxy). When
  `TRUSTED_PROXY_IPS` is unset, forwarded headers are **ignored**: every
  client is reported as `"unknown"`, per-IP rate limits collapse into one
  shared bucket, and request origins fall back to the Host header. That
  is the fail-safe posture — it cannot be spoofed, but it also means a
  single abusive client shares a bucket with everyone else. Set the
  variable to the production proxy's IPs as soon as the proxy is named.
  See `src/lib/trusted-proxy.ts`, `src/lib/rate-limit.ts` (`clientIp`),
  `src/lib/request-origin.ts`.
- **Rate limits are per instance** (in-memory). The login limiter
  (10/min per IP + 5/min per email hash, failures only), the API limits
  (quote/cart/wishlist 60/min per IP; upload 10/min, import 5/min,
  export 30/min per admin; webhook 600/min global + 60/min per IP;
  health 300/min global) and the CSRF check all run in process. A
  multi-instance deployment needs the shared store (PR-11, blocked on
  Q-01/Q-02) before per-IP limits mean anything across instances.
- **Admin MFA is bound to the session** (`sid` claim +
  `AdminMfa.lastVerifiedSessionId`). Admins signed in before the deploy
  re-verify MFA once after signing in again; there is no migration of
  old sessions. See `docs/ADMIN-MFA.md`.

## The Caddyfile (retained, status unverified)

The repo's `Caddyfile` listens on plain HTTP `:81` and proxies to
`localhost:3000`, with an `XTransformPort` query handler that forwards to
an arbitrary localhost port. **Nothing in the repo establishes that this
file is the production proxy** (see `docs/SECURITY-HEADERS.md` for the
full trust analysis), and it dates from the initial project checkpoint.
It appears to serve the sandbox preview, not production. It is retained
because its production use cannot be established, and deleting a proxy
config on a guess would be worse than keeping it. Do not assume it fronts
production, and do not rely on it for `X-Forwarded-For` trust: the
production server may be directly reachable on `:3000`.

## What was removed (deployment legacy cleanup)

- `project-structure.txt` — a stale Windows-generated snapshot (BOM,
  backslashes) listing deleted files (`bun.lock`, 24 removed shadcn
  components, `tailwind.config.ts`, the pre-PR-07 `supabase/migrations/`
  paths) and missing everything added since PR-03. Unreferenced anywhere.
  The README's `## Architecture` section is the maintained structure
  reference.
- `project-audit.txt` — an empty tracked file (0 lines), unreferenced.
- `tests/database-runtime-build.sh`, `tests/python-runtime-build.sh`,
  `tests/python-runtime-container.sh` — tests for the platform's
  `.zscripts` runtime builder, which is absent from this repo. Invoked
  by nothing (no package script, CI step, or doc) and unable to run (the
  first `cd` into `../.zscripts` fails). The app has no Python code and
  no Docker-based deploy; these tested the scaffolding platform's
  builder, not the app.
- `.env.example`: removed `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (never
  read anywhere — the browser never talks to Supabase directly, and
  Storage uses the server-side service-role key) and documented
  `LOG_LEVEL` (read by `src/lib/performance-timing.ts`, previously
  absent from the template).

## Remaining deployment concerns

- The production host/platform and any reverse proxy in front of it are
  not documented anywhere in the repo. The trust model for forwarded
  headers is now settled in code (`TRUSTED_PROXY_IPS`, fail-safe when
  unset — see "Production security configuration" above), but the proxy
  itself still needs naming here with its IPs, so `TRUSTED_PROXY_IPS`
  can be set and per-IP rate limiting can work as designed instead of
  collapsing into one shared bucket.
- The README tagline still calls the platform "complete,
  production-ready" — the audit found it is not yet production-ready for
  online payments (Safepay is sandbox-only by design). That claim is a
  product statement, not a deployment instruction, and was left alone.
- The probe/verify/diagnostic scripts under `scripts/` (e.g.
  `probe-prod.sh`, `verify-*.sh`) hardcode the original dev machine's
  path (`/home/z/my-project`) and target a local build on
  `localhost:3000`. They are one-off diagnostics, not deployment, and
  were kept — but they do not run on any other machine as written.
