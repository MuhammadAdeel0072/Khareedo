# Khareedo — Smart E-Commerce Platform

A complete, production-ready e-commerce platform: customer storefront + admin dashboard,
built with **Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui · Prisma**.
Database migrations for **Supabase PostgreSQL (with RLS)** ship in `supabase/migrations/`.

> Full requirement traceability: [`docs/REQUIREMENTS-TRACEABILITY.md`](docs/REQUIREMENTS-TRACEABILITY.md)
> Business decisions & open items: [`docs/DECISIONS.md`](docs/DECISIONS.md)
> Production Supabase setup: [`docs/SUPABASE-SETUP.md`](docs/SUPABASE-SETUP.md)

## Feature summary

| Area | What's included |
|------|-----------------|
| Storefront | Homepage (hero banners, category circles, promos, featured/new products), listing with search + category/price/stock filters + sorting + pagination, product details with gallery, ratings, related products |
| Cart & checkout | Persistent carts for guests (cookie session) & customers, server-side pricing at every step, coupons, gift wrapping, delivery options, 4-step checkout, idempotent order placement |
| Orders | Unique order references, confirmation page, status tracking, customer order history, guest order access via know-only link |
| Accounts | Email/password + Google-ready auth, profile, address book with defaults, wishlist |
| Admin | Dashboard (real DB stats + charts), products CRUD + upload, categories, inventory with validation, order status state machine, customers, banners, coupons, promotions, reports, store settings — everything configurable without code changes |
| Integrations | WhatsApp deep links (header, float button, product & cart inquiries — clearly NOT orders), Google OAuth boundary, payments table + disabled toggle until a provider is chosen |
| Security | Route guard (proxy) + per-route + service-layer authorization, ownership checks, rate limiting on register/checkout, zod validation everywhere, bcrypt password hashing, idempotency keys, no client-trusted prices |
| Tests | 33 Vitest unit/integration tests (pricing engine, validation, idempotency constraint, stock guard, cancellation restore) + Playwright e2e suites for guest/customer/admin journeys |

## Quick start (sandbox/demo)

```bash
npm install            # or: bun install
cp .env.example .env   # defaults work for local SQLite
npx prisma db push     # create schema
npx tsx scripts/seed.ts   # or: bun scripts/seed.ts  (demo catalog + users)
npm run dev            # http://localhost:3000
```

For detailed Prisma and performance diagnostics, set `LOG_LEVEL=debug` before starting the development server.

### Demo accounts (seeded)

| Role | Email | Password |
|------|-------|----------|
| Administrator | `admin@khareedo.pk` | `Admin@123` |
| Customer | `ali.hassan@example.com` | `Customer@123` |
| Customer | `sara.khan@example.com` | `Customer@123` |

> ⚠️ Change these before any real deployment. Demo orders/coupons are seed data —
> `npx prisma migrate reset` wipes everything.

## Scripts

```bash
npm run dev          # dev server (port 3000)
npm run lint         # ESLint
npm run build        # production build
bunx vitest run      # unit + integration tests
npx playwright test  # e2e (needs: npx playwright install chromium)
bun scripts/seed.ts  # re-seed demo data
bun scripts/generate-images.ts --max-seconds=300 --concurrency=2
                     # regenerate product/banner images (resumable, skips existing)
```

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
supabase/migrations/        # production Postgres schema + RLS policies
scripts/                    # seed + image generation
tests/                      # vitest unit/integration + playwright e2e
```

**Layering (NFR-20):** `app` (UI) → `services` (business logic) → `lib/db` (data access).
Prices/totals are ALWAYS computed server-side in `src/lib/pricing.ts` from DB values —
the browser never supplies authoritative amounts (BR-04/06).

## Key business rules enforced

- Guest checkout enabled; guests provide contact + delivery details (D-01, BR-02)
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
