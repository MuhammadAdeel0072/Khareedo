# Prisma schema and lockfile strategy (PR-08)

## Two schemas, one logical model

Khareedo keeps **two Prisma schema files** because Prisma gives each schema
a single provider, and this repo genuinely needs both:

| File | Provider | Purpose | Client |
| --- | --- | --- | --- |
| `prisma/schema.postgres.prisma` | `postgresql` | **The application schema.** Supabase PostgreSQL is the application database. Its migrations live in `prisma/migrations/` and are applied only by `prisma migrate deploy` (see `docs/SQL-SAFETY.md`). | `generated/postgres-client` |
| `prisma/schema.sqlite.prisma` | `sqlite` | **The test schema.** Isolated disposable SQLite databases for `npm run test:db` and explicitly supported local-only SQLite workflows (seed, local `db:push`). Never production data. | `generated/sqlite-client` |

Both files describe the **same models, fields, and indexes**. The only
permitted differences are the datasource provider, the generator output
path, the Postgres-only `binaryTargets` / `previewFeatures`, and the header
comment. `tests/unit/prisma-lockfile.test.ts` enforces this mechanically:
it strips comments and blank lines, removes exactly those allowlisted
lines, and requires the two schemas to be otherwise identical. If you
change a model, change it in **both** files (and, for PostgreSQL, in a
migration — never edit the live schema by hand).

**There is no default schema.** The files are named
`schema.postgres.prisma` and `schema.sqlite.prisma` on purpose: the old
`prisma/schema.prisma` (SQLite) was the implicit default, so a bare
`prisma generate` / `prisma db push` silently targeted SQLite. After the
rename a bare Prisma command fails instead of guessing, and every real
command names its schema explicitly (below).

## Generation commands

| Command | What it does |
| --- | --- |
| `npm run db:generate` | `prisma generate --schema prisma/schema.sqlite.prisma` → `generated/sqlite-client` (tests) |
| `npm run db:generate:postgres` | `prisma generate --schema prisma/schema.postgres.prisma` → `generated/postgres-client` (the app) |
| `npm run build` | Generates the PostgreSQL client, then builds Next.js |
| CI (`Quality checks`) | `npm ci`, then both `db:generate:postgres` and `db:generate`, then typecheck, lint, `test:db`, build |

`generated/` is gitignored build output — never commit it, never edit it
by hand. Regenerate after any schema change. `prisma db push` and
`prisma migrate dev`/`reset` are **not** run bare: they go through the
guarded wrapper (`npm run db:push` / `db:migrate` / `db:reset`, see
`docs/SQL-SAFETY.md`), which refuses anything but a local `file:` target
with an explicit opt-in. The deploy path (`npm run db:postgres:deploy`,
`prisma migrate deploy` with its own project-target check) is the only way
schema changes reach Supabase.

Supporting SQL (not schema definitions): `prisma/migrations/` holds the
four applied PostgreSQL migrations; `prisma/sqlite-safepay-test-constraints.sql`
is applied by the test harness to disposable SQLite databases only.

## Package manager: npm only

- **npm is the only package manager.** Install with `npm install` locally
  and `npm ci` in CI. `package-lock.json` is the only lockfile.
- **`bun.lock` was removed in PR-08.** It was stale (it pinned `next`
  16.1.3 and `prisma` 6.19.2 while `package-lock.json` has 16.4.5 and
  6.19.3) and unrequired: CI installs with `npm ci`, no script runs
  `bun install`, and running code never reads a lockfile. `.gitignore`
  lists `bun.lock`, `yarn.lock`, and `pnpm-lock.yaml` so a competing
  lockfile cannot come back by accident, and the test below fails if one
  appears in the tree.
- **`bun` remains only as a JavaScript/TypeScript runtime** — to run the
  built server (`bun .next/standalone/server.js`, the `start` script) and
  TS scripts such as the seed (`bun scripts/seed.ts`). It never installs
  dependencies. No `Bun.*` runtime API is used anywhere in `src/` or
  `scripts/`, so `bun-types` is only a types package for that runtime use.

## Known limitations (not fixed here)

- The PostgreSQL schema's section comments contain mojibake (UTF-8
  characters corrupted to `â€…` sequences, 12 lines) — cosmetic only,
  comments do not affect Prisma. Left alone; a comment-only cleanup can
  fix it later.
- The PostgreSQL schema declares four indexes whose comment cites
  migration `20261109000000`, which has no migration directory (a
  pre-existing drift finding from the audit). The SQLite schema mirrors
  those indexes so the two files stay in sync; resolving the
  schema-vs-database drift itself needs a reviewed migration, which is
  out of scope for this PR.
- `.env.example` defaults `DATABASE_URL` to `file:./db/custom.db`, a
  legacy local file that does not exist in a fresh checkout. The guarded
  `db:push` creates it (resolved under `prisma/`, per the PR-07
  schema-directory rule) — the default was left as-is.
