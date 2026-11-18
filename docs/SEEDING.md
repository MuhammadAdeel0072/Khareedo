# Database seeding (PR-06)

Khareedo has one seed script, `scripts/seed.ts`, and one SQL seed file,
`docs/legacy/supabase-migrations/seed.sql`. Both follow the same rule: **a seed never
provisions a login account with a known password, and never destroys data.**

## The seed script (`scripts/seed.ts`)

### Guards — seeding refuses unless all of these hold

| Check | Rule |
|---|---|
| Opt-in | `SEED_ALLOW` must be exactly `1` on every run. There is no persistent "seeding enabled" state. |
| Environment | `NODE_ENV` must not be `production`. Seeding is never allowed in production. |
| Target | `DATABASE_URL` must be set and must be a local SQLite `file:` URL. The seed uses the SQLite Prisma client, so it can only ever touch a local SQLite file — but the check is explicit, and a missing or non-`file:` value fails safe instead of guessing. |

A refusal prints the reason and exits non-zero. Nothing is written.

### What a run does — and does not do

- **Never deletes rows.** The old seed wiped every content table (including
  users) on every run. The new seed has no `deleteMany` anywhere.
- **Never overwrites existing rows.** Every write is an upsert that leaves an
  existing row untouched (`update: {}`), or a create-if-missing. Settings an
  admin changed, a coupon's `usedCount`, a product's stock level, and an
  order's status all survive a re-run.
- **Safe to rerun.** A second run only fills in missing seed data; counts do
  not change and no duplicates are created.
- **For a clean slate**, delete the SQLite file and re-run the guarded
  `DB_DESTRUCTIVE_ALLOW=1 npm run db:push` + the seed — do not add a wipe
  mode to the seed, and do not run a bare `prisma db push` (it bypasses the
  target guards in `docs/SQL-SAFETY.md`).

### Accounts

No demo accounts exist by default. The seed creates these accounts **only**
when a password is supplied for them through the environment:

| Account | Email | Password env var |
|---|---|---|
| Administrator | `admin@khareedo.pk` | `SEED_ADMIN_PASSWORD` |
| Customer | `ali.hassan@example.com` | `SEED_CUSTOMER_PASSWORD` |
| Customer | `sara.khan@example.com` | `SEED_CUSTOMER_PASSWORD` |

```bash
SEED_ALLOW=1 SEED_ADMIN_PASSWORD=<strong-password> SEED_CUSTOMER_PASSWORD=<strong-password> bun scripts/seed.ts
# tsx does not auto-load .env — use --env-file=.env with it:
SEED_ALLOW=1 npx tsx --env-file=.env scripts/seed.ts
```

Password rules (enforced by `src/lib/seed-guards.ts`, unit-tested):

- 12–72 characters (the application caps passwords at 72, the bcrypt limit).
- Never a published demo password (`Admin@123` / `Customer@123`, even as a
  substring) or another common default.
- Missing password: the account is skipped, not created with a fallback.
  The run still seeds the catalog and reports which accounts were skipped.
- Invalid password: the seed fails loudly instead of creating a weak account.
- An account that already exists is left completely untouched — a re-run
  never resets its password or role.

Passwords are never printed in logs or error messages. Keep
`SEED_ADMIN_PASSWORD` / `SEED_CUSTOMER_PASSWORD` in your local environment
only — never commit them.

Demo orders for an account are created only if that account exists; guest
demo orders are always created (if their reference is not already present).

### E2E tests

`tests/e2e/customer-admin-journeys.spec.ts` signs in as the seeded accounts,
so it needs the same passwords the seed ran with:

```bash
SEED_ALLOW=1 SEED_ADMIN_PASSWORD=<...> SEED_CUSTOMER_PASSWORD=<...> bun scripts/seed.ts
SEED_ADMIN_PASSWORD=<...> SEED_CUSTOMER_PASSWORD=<...> npx playwright test
```

The spec reads both from the environment and fails fast with a clear message
if either is unset. No password is stored in the spec file.

## The SQL seed (`docs/legacy/supabase-migrations/seed.sql`)

The committed `seed.sql` is legacy demo data, quarantined under `docs/legacy/`
in PR-07 (it targets the old snake_case Supabase Auth profile schema and is
**not** compatible with the current Prisma/NextAuth models — see
`docs/SUPABASE-SETUP.md` and `docs/DATABASE-MIGRATION.md`; do not apply it to
the application database).

It provisions catalog and settings only. It never creates accounts and
carries no password hashes. Re-applying it never overwrites existing rows:
store settings and inventory quantities use `ON CONFLICT DO NOTHING`, so
an operator's settings and live stock levels survive a re-applied seed.
The exporter that regenerates it,
`scripts/export-seed-sql.ts`, exports catalog/settings only for the same
reason — it reads the database configured by `SUPABASE_POSTGRES_URL` but
never writes to it, and it never exports accounts.

## Related paths (audited, not changed)

- `scripts/migrate-sqlite-to-postgres.mjs` transfers data (including users)
  from SQLite to Postgres. It is a one-time migration tool, dry-run by
  default, and it verifies the Postgres target matches the configured
  Supabase project before doing anything. Before any transfer, delete demo
  accounts from the source database or rotate their passwords — the transfer
  copies whatever accounts exist.
- `scripts/verify-*.sh`, `scripts/probe-*.sh`, `scripts/audit-authz.mjs`,
  and `scripts/diag-checkout-payment.mjs` sign in as the seeded accounts
  for local verification. They read the passwords from `SEED_ADMIN_PASSWORD`
  / `SEED_CUSTOMER_PASSWORD` and refuse to run when they are unset.
- The isolated CI database tests (`npm run test:db`) build their own
  disposable SQLite databases and never use the seed script. The seed
  suite (`tests/unit/integration.seed.test.ts`) runs against its own fresh
  disposable database, separate from the shared database the other suites
  use, so it cannot see rows created by another suite in any execution
  order (see `scripts/run-isolated-sqlite-tests.mjs`).
