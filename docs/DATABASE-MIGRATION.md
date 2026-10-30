# SQLite to Supabase PostgreSQL cutover

## Current state

- The PostgreSQL import is complete: 18,014 records were independently
  reconciled. Do not rerun a data-transfer/import command as part of this
  cutover.
- The app runtime uses the generated client from
  `prisma/schema.postgres.prisma` and connects through
  `SUPABASE_POSTGRES_URL`.
- `DATABASE_URL` remains the SQLite URL for local Prisma operations and the
  disposable SQLite test harness. It is not the application runtime URL.
- Keep `db/custom.db` and its verified backup unchanged.

## Do not use the legacy SQL files

`supabase/migrations/0001_schema.sql`, `0002_rls.sql`, and `seed.sql` describe a
different snake_case schema based on Supabase Auth profiles. They do not match
the current Prisma/NextAuth models. Do not run these files for this migration.
Use the reviewed Prisma migrations under `prisma/migrations/`.

The application accesses the database only from server-side Prisma code and
continues to use NextAuth. The access migration revokes table access from
`PUBLIC`, `anon`, and `authenticated`; no Supabase browser client or service-role
key is required for application database access.

## TLS and schema changes

The application enforces `sslmode=verify-full` for its Supabase connection. If
`SUPABASE_DB_CA_CERT` is configured, its certificate is also supplied to Prisma
as the trusted root; otherwise certificate verification uses the runtime's
trusted roots. Configure `SUPABASE_POSTGRES_URL` and, when using the downloaded
CA, `SUPABASE_DB_CA_CERT` in the deployment environment. The standalone build
omits `.env`, so inject runtime secrets through the deployment platform and
include the CA certificate file at the configured path. Keep the URL
server-side and never print it.

Download the database CA certificate from Supabase **Database Settings →
SSL Configuration** and set its runtime path in `SUPABASE_DB_CA_CERT`.
`db:postgres:deploy` is only for a separately reviewed future schema change; it
is not required to complete the application cutover:

```powershell
npx prisma validate --schema .\prisma\schema.postgres.prisma
npm run db:postgres:deploy
```

That script uses `prisma migrate deploy`; it does not reset or push the schema.
Do not run schema-changing commands against production as part of this
application-only cutover.

## Completed data transfer

The PostgreSQL import has already completed and its 18,014 records were
independently verified. The transfer scripts remain available for controlled
recovery work, but do not use them against the production database for this
cutover.

## Cutover and rollback

The regular application runtime now uses the PostgreSQL Prisma client and
`SUPABASE_POSTGRES_URL`. SQLite tests select their generated SQLite client only
when launched through the marked disposable-database harness. Keep
`DATABASE_URL` pointed at SQLite and keep `db/custom.db` and its backup.

To roll back application traffic, deploy the previous SQLite application
version and its matching generated client after stopping writes. Do not delete
PostgreSQL data or the SQLite backup; reconcile writes made after cutover before
attempting another switch.
