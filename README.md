# Khareedo — Smart E-Commerce Platform

A complete, production-ready e-commerce platform: customer storefront + admin dashboard,
built with **Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma**.
Database migrations for **Supabase PostgreSQL** ship in `prisma/migrations/` (applied with `npm run db:postgres:deploy`).

> Full requirement traceability: [`docs/REQUIREMENTS-TRACEABILITY.md`](docs/REQUIREMENTS-TRACEABILITY.md)
> Business decisions & open items: [`docs/DECISIONS.md`](docs/DECISIONS.md)
> Production Supabase setup: [`docs/SUPABASE-SETUP.md`](docs/SUPABASE-SETUP.md)

## Feature summary

| Area | What's included |
|------|-----------------|
| Storefront | Homepage (hero banners, category circles, promos, featured/new products), listing with search + category/price/stock filters + sorting + pagination, product details with gallery, ratings, related products |
| Cart & checkout | Persistent carts for guests (cookie session) & customers, server-side pricing at every step, coupons, gift wrapping, delivery options, 4-step checkout, idempotent order placement |
| Orders | Unique order references, confirmation page, status tracking, customer order history; order tracking requires sign-in + ownership |
| Accounts | Email/password + Google-ready auth, profile, address book with defaults, wishlist, password reset ([docs/PASSWORD-RESET.md](docs/PASSWORD-RESET.md)) |
| Admin | Dashboard (real DB stats + charts), products CRUD + upload, categories, inventory with validation, order status state machine, customers, banners, coupons, promotions, reports, store settings — everything configurable without code changes |
| Integrations | WhatsApp deep links (header, float button, product & cart inquiries — clearly NOT orders), Google OAuth boundary, payments table + disabled toggle until a provider is chosen |
| Security | Route guard (proxy) + per-route + service-layer authorization, ownership checks, rate limiting on login/register/checkout/quote/cart/wishlist/uploads/imports/exports/webhook/health, CSRF same-origin validation in the proxy, zod validation everywhere, bcrypt password hashing, idempotency keys, no client-trusted prices, security response headers + report-only CSP ([docs/SECURITY-HEADERS.md](docs/SECURITY-HEADERS.md)), admin TOTP MFA bound to the session id ([docs/ADMIN-MFA.md](docs/ADMIN-MFA.md)), append-only admin audit log ([docs/ADMIN-AUDIT-LOG.md](docs/ADMIN-AUDIT-LOG.md)), trusted-proxy config + Secure cookies in production ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)) |
| Tests | 33 Vitest unit/integration tests (pricing engine, validation, idempotency constraint, stock guard, cancellation restore) + Playwright e2e suites for guest/customer/admin journeys |

## Quick start (sandbox/demo)

```bash
npm ci
cp .env.example .env   # defaults work for local SQLite
DB_DESTRUCTIVE_ALLOW=1 npm run db:push   # create schema (guarded: local SQLite only, see docs/SQL-SAFETY.md)
SEED_ALLOW=1 bun scripts/seed.ts   # demo catalog + settings (no accounts by default)
npm run dev            # http://localhost:3000
```

For detailed Prisma and performance diagnostics, set `LOG_LEVEL=debug` before starting the development server.

### Seeding

The seed is opt-in, non-destructive, and local-only: it refuses unless
`SEED_ALLOW=1`, never runs in production, and only touches a local SQLite
`file:` database. Re-running it only fills in missing demo data — it never
deletes or overwrites existing rows.

**No demo accounts exist by default.** The seed creates the admin/customer
accounts only when their passwords are supplied through the environment:

```bash
SEED_ALLOW=1 SEED_ADMIN_PASSWORD=<strong-password> SEED_CUSTOMER_PASSWORD=<strong-password> bun scripts/seed.ts
```

Passwords must be 12–72 characters and must never be a published demo
password or another common default. An account that already exists is left
untouched. See [docs/SEEDING.md](docs/SEEDING.md) for the full contract.

## Scripts

```bash
npm run dev          # dev server (port 3000)
npm run lint         # ESLint
npm run build        # production build
npx vitest run       # unit + integration tests
npx playwright test  # e2e (needs: npx playwright install chromium)
bun scripts/seed.ts  # re-seed demo data (requires SEED_ALLOW=1; see docs/SEEDING.md)
bun scripts/generate-images.ts --max-seconds=300 --concurrency=2
                     # regenerate product/banner images (resumable, skips existing)
```

npm is the only package manager (`package-lock.json` is the only lockfile).
`bun` is used only as a JavaScript/TypeScript runtime — to run the built
server (`bun .next/standalone/server.js`) and TS scripts such as the seed —
never to install dependencies. See [docs/PRISMA.md](docs/PRISMA.md).

## Operations: health and worker heartbeat

- `GET /api/health` is a public, unauthenticated endpoint for load balancers
  and uptime monitors. It returns `{ status, timestamp, checks: { database, worker } }`
  with `Cache-Control: no-store`. Status is `ok` (database reachable and worker
  heartbeat fresh), `degraded` (database reachable but the worker is stale,
  failing, stopped or never started — HTTP 200), or `down` (database
  unreachable — HTTP 503). The response contains only coarse statuses, ISO
  timestamps and counts — no error messages, stack traces, connection strings
  or environment values.
- The payment maintenance worker (`src/instrumentation.ts` →
  `src/services/payment-maintenance-worker.service.ts`) records a heartbeat on
  every sweep: start time, last success, last failure (generic code only),
  consecutive failures and sweep counts (`src/services/worker-heartbeat.ts`).
  A heartbeat is stale after 3 minutes without a successful sweep (3x the 60s
  sweep interval). Set `PAYMENT_MAINTENANCE_WORKER=off` to disable the
  in-process worker (serverless deploys should call
  `POST /api/admin/payments/maintenance` from an external cron instead).
- Limitation: the heartbeat is per-process and in-memory. In a multi-instance
  deployment each instance reports its own worker state, so a load balancer
  may see different states per instance. This matches the current
  single-instance deployment assumption.

## Operations: error monitoring and payment alerts

- Unexpected server-side errors are captured centrally by
  `src/lib/error-monitoring.ts`: one sanitised, structured JSON log line per
  error (name, scrubbed message, operation, request id — no secrets, no
  customer data, no payloads; stacks in development only). Sources: every
  route wrapped in `handleRoute`, process-level uncaught exceptions and
  escalated unhandled rejections (captured through the observe-only
  `uncaughtExceptionMonitor` listener in `src/instrumentation.ts`, which
  never changes Node.js default termination behaviour), and worker
  start failures.
- Critical payment failures additionally raise a `payment-alert`:
  `WORKER_FAILURE` (sweep threw), `WEBHOOK_FAILURE` (receive failure,
  blocked delivery, quarantined/conflicting event, blocked inbox
  processing), `PAYMENT_FAILURE` (failed refund submission), and
  `RECONCILIATION_FAILURE` (provider fetch failed during reconciliation or
  targeted verification). When `ERROR_MONITORING_ALERT_EMAIL` is set and
  SMTP is configured, alerts are also emailed (throttled to one per
  kind+code every 15 minutes by default); without credentials the email is
  skipped and the log line still fires. Set
  `ERROR_MONITORING_ENABLED=false` to disable capture entirely.
  See `docs/ERROR-MONITORING.md` for setup, configuration and failure
  scenarios.

## Architecture

```
src/
├── app/
│   ├── (store)/            # customer storefront (public + account areas)
│   │   ├── page.tsx        # homepage
│   │   ├── products/       # listing (search/filter/sort/pagination)
│   │   ├── product/[slug]/ # details
│   │   ├── cart/ checkout/ order/[reference]/
│   │   ├── account/        # profile, addresses, orders, wishlist (guarded)
│   │   └── login/ register/ contact/ categories/
│   ├── admin/
│   │   ├── login/          # separate admin login
│   │   └── (panel)/        # dashboard, products, categories, inventory,
│   │                       # orders, customers, banners, coupons,
│   │                       # promotions, reports, settings (role-guarded)
│   └── api/                # auth, register, cart, checkout, wishlist,
│                           # account, admin/* (every mutation validated)
├── components/             # ui/ (shadcn), layout/, products/, cart/,
│                           # checkout/, account/, admin/
├── lib/                    # auth, auth-guard, pricing (pure), validation,
│                           # rate-limit, whatsapp, constants, utils
├── services/               # products, categories, cart, checkout, orders,
│                           # inventory, wishlist, promotions, banners,
│                           # settings, reports, users  (all business logic)
├── types/
└── proxy.ts                # Next.js 16 route guard (/admin, /account)
prisma/migrations/          # reviewed Postgres migrations (deploy: npm run db:postgres:deploy)
docs/legacy/                # quarantined legacy Supabase SQL (never apply)
scripts/                    # seed + image generation
tests/                      # vitest unit/integration + playwright e2e
```

**Layering (NFR-20):** `app` (UI) → `services` (business logic) → `lib/db` (data access).
Prices/totals are ALWAYS computed server-side in `src/lib/pricing.ts` from DB values —
the browser never supplies authoritative amounts (BR-04/06).

## Key business rules enforced

- Guest checkout disabled — checkout and order tracking require sign-in; only Cash on Delivery and Safepay are supported, bank transfer is not offered or accepted (D-01, D-02, BR-02, BR-10)
- COD is the initial payment method; online payments stay disabled until a provider
  is configured — no fake confirmations (D-02, BR-10, FR-23)
- Stock re-validated at placement with a race-safe conditional decrement — two customers
  can never buy the same last unit (BR-05)
- Every checkout attempt carries a unique idempotency key; retries never duplicate orders
  (FR-27, BR-08)
- Orders snapshot prices, delivery details and gift-wrap charges — later admin changes
  never alter recorded totals (BR-09, BR-15, NFR-31)
- Order status follows a fixed state machine; cancellation restores stock (BR-11)
- WhatsApp inquiries are clearly labelled as inquiries, never orders (BR-13)

## Known limitations

See `docs/DECISIONS.md` — summary: online payments await a provider choice; Google sign-in
needs OAuth credentials; WhatsApp number is a placeholder configurable in Admin → Settings;
the sandbox build runs on SQLite (Supabase/Postgres migration path documented); display-only
ratings (no customer review submission) per confirmed scope.
