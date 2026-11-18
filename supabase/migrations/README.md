# supabase/migrations — pointer only

The legacy Supabase SQL files that used to live here were quarantined in
PR-07 (2026-11-18) because they describe an incompatible snake_case schema
based on Supabase Auth profiles and must never be applied to the current
Prisma/NextAuth database:

- `docs/legacy/supabase-migrations/0001_schema.sql` — legacy schema
- `docs/legacy/supabase-migrations/0002_rls.sql` — legacy RLS policies
- `docs/legacy/supabase-migrations/seed.sql` — legacy demo seed
  (catalog/settings only, never accounts)

The authoritative schema is the reviewed Prisma migrations under
`prisma/migrations/`, applied with `npm run db:postgres:deploy`. Do not put
SQL files back in this directory — nothing in the deploy path may create the
legacy schema. See `docs/SQL-SAFETY.md`.
