# SQL safety (PR-07)

How Khareedo keeps the legacy schema and destructive database commands away
from the production Supabase database.

## The rule

- **Supabase PostgreSQL is the application database.** It is reached only
  through the server-side Prisma client (`prisma/schema.postgres.prisma`) and
  the reviewed migrations under `prisma/migrations/`.
- **SQLite is only for isolated testing and local development.** It is never
  the production database.
- **No destructive operation runs against production.** Ever. The guards in
  this document fail closed: a missing check, a missing opt-in, or an
  ambiguous target refuses the operation instead of guessing.

## Quarantine: the legacy SQL files (F-08, N-05)

The three legacy Supabase SQL files were moved — not deleted — from
`supabase/migrations/` to `docs/legacy/supabase-migrations/` in PR-07, so
their history is preserved by the rename:

| File | What it is |
| --- | --- |
| `0001_schema.sql` | Legacy snake_case schema (Supabase Auth profiles); incompatible with the current Prisma/NextAuth models |
| `0002_rls.sql` | Legacy row-level-security policies for that schema |
| `seed.sql` | Legacy demo seed — catalog/settings only, never accounts, never overwrites (see `docs/SEEDING.md`) |

`supabase/migrations/` now holds only a `README.md` pointer. Nothing in the
deploy path can create the legacy schema. The authoritative schema is the
reviewed Prisma migrations under `prisma/migrations/`, applied with
`npm run db:postgres:deploy` (see `docs/DATABASE-MIGRATION.md`).

Do not put SQL files back under `supabase/migrations/`, and do not apply the
quarantined files to any database. If a migration's status is uncertain,
leave the file untouched and ask — never apply it to find out.

## Guarded commands

All guards live in `scripts/db-target-guards.mjs` (pure functions, unit
tested in `tests/unit/db-target-guards.test.ts`). They take the environment
as an argument, so tests exercise the exact code the scripts use.

### `db:push`, `db:reset`, `db:migrate` — via `scripts/guard-destructive-db.mjs`

The npm scripts no longer call Prisma directly:

| Script | Runs (guarded) |
| --- | --- |
| `npm run db:push` | `prisma db push --accept-data-loss` |
| `npm run db:reset` | `prisma migrate reset` |
| `npm run db:migrate` | `prisma migrate dev` |

The wrapper refuses unless **all** of these hold, in order:

1. `DATABASE_URL` is set and is a genuine local `file:` URL: no
   hostname/authority (`file://server/...`, `file://localhost/...`), no
   query string, no fragment, no network (UNC-style) path, and no malformed
   URL. Any PostgreSQL URL refuses — these commands never target Supabase.
   A missing `DATABASE_URL` refuses instead of falling back to a default.
   A relative `file:` URL (`file:./dev.db`) resolves against the Prisma
   schema directory (`prisma/`), because that is where Prisma itself puts
   the file — so the target the wrapper prints is the target Prisma
   actually uses.
2. `NODE_ENV` is not `production`.
3. `DB_DESTRUCTIVE_ALLOW=1` is set exactly (the explicit opt-in; `"true"`,
   `"yes"`, and `"0"` all refuse).

`--dry-run` prints the exact Prisma command and the resolved target path and
exits without executing anything:

```sh
DB_DESTRUCTIVE_ALLOW=1 DATABASE_URL='file:./dev.db' npm run db:push -- --dry-run
```

To run for real (local SQLite only):

```sh
DB_DESTRUCTIVE_ALLOW=1 DATABASE_URL='file:./dev.db' npm run db:push
```

The legitimate Postgres deploy path is unchanged and separate:
`npm run db:postgres:deploy` runs `prisma migrate deploy`, which only applies
pending migrations and never resets or pushes the schema.

### Dev cleanup scripts — dry-run by default

| Script | Deletes | Guard |
| --- | --- | --- |
| `scripts/clean-e2e-artifacts.mjs` | E2E/audit junk orders and products (by name) | Local `file:` target only; dry-run by default, `--apply` to delete |
| `scripts/cleanup-import-test.mjs` | `Import Smoke*` products (with images/inventory) | Local `file:` target only; dry-run by default, `--apply` to delete |
| `scripts/audit-concurrency.mjs` | Only the orders/products it created (tracked IDs) | Base URL must be `http://localhost:*`; `DATABASE_URL` must be explicitly set to a validated local `file:` URL (a localhost base alone does not establish the database target); never production |

Without `--apply`, a cleanup script lists exactly what it would delete and
deletes nothing. `scripts/verify-import-export.sh` passes `--apply` because
that flow verifies the deletion happened.

## Reviewed, not changed

These scripts were audited in PR-07 and already fail closed; their behavior
is unchanged:

- **`scripts/seed.ts`** (PR-06): refuses unless `SEED_ALLOW=1`,
  `NODE_ENV` is not production, and `DATABASE_URL` is a local `file:` URL.
  Never deletes or overwrites rows. See `docs/SEEDING.md`.
- **`scripts/deploy-postgres-migrations.mjs`**: runs `prisma migrate deploy`
  (applies pending migrations only — no reset, no push). Refuses unless
  `SUPABASE_POSTGRES_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and
  `SUPABASE_DB_CA_CERT` are set, and unless the database URL matches the
  configured Supabase project. This is the only script that writes schema
  changes to Supabase, and only for a separately reviewed schema change.
- **`scripts/migrate-sqlite-to-postgres.mjs`**: dry-run by default
  (`--apply` required, and `--apply` with `--dry-run` is an error). Verifies
  the target matches the configured Supabase project, requires the `public`
  schema, refuses unexpected tables, inserts with `ON CONFLICT DO NOTHING`,
  verifies every row, and rolls the whole transfer back on any conflict or
  mismatch. It never overwrites or deletes destination rows. Do not run it
  against production for routine work — the transfer already completed (see
  `docs/DATABASE-MIGRATION.md`).
- **`scripts/run-isolated-sqlite-tests.mjs`**: the test harness only ever
  creates marked disposable SQLite databases under the OS temp directory and
  refuses any other target. See its safety checks and
  `tests/helpers/disposable-sqlite.mjs`.

## If you are unsure

Stop. Do not run a database command to find out what it does. Check this
document, `docs/DATABASE-MIGRATION.md`, and `docs/SEEDING.md` first. A
destructive command that refuses is working as designed — the refusal message
says which check failed.
