# Supabase setup

The current application uses Prisma and NextAuth. Its PostgreSQL schema,
reviewed migration steps, data-transfer commands, TLS requirements, and rollback
procedure are documented in [DATABASE-MIGRATION.md](./DATABASE-MIGRATION.md).

Do **not** run `supabase/migrations/0001_schema.sql`,
`supabase/migrations/0002_rls.sql`, or `supabase/migrations/seed.sql` for this
application. Those legacy files describe a different snake_case schema and
Supabase Auth profile model; they are not compatible with the current Prisma
models or authentication system.

The application database connection and migration credentials must remain
server-side. The storefront does not connect directly to PostgreSQL.
