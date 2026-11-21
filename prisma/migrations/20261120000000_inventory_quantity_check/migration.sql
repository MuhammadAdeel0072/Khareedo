-- Inventory quantity floor (Phase 3, Chunk 12 follow-up — M-15).
-- Additive only: a CHECK constraint on the existing Inventory table. All
-- existing rows satisfy quantity >= 0 (every application writer already
-- guards it: conditional decrements with `gte` predicates and the validated
-- admin write path); the constraint is a backstop against a careless writer
-- bypassing the service layer. Mirrored for the SQLite test harness in
-- prisma/sqlite-safepay-test-constraints.sql (Inventory_quantity_check
-- triggers). No RLS change: this alters a table whose RLS state is already
-- set by the initial migration.

BEGIN;

ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_quantity_check"
  CHECK (("quantity" >= 0) IS TRUE);

COMMIT;
