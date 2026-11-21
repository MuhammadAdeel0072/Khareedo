-- Cart optimistic-lock version (Phase 3, Chunk 3-final — Safepay cart lock Low).
-- Additive only: one new column with a default; no existing rows change.
-- The Safepay pending-order creation claims the cart version-gated before
-- reading its snapshot (see safepay-pending-order.service.ts), so the
-- previous plain updateMany on the cart row is a real lock: a second
-- concurrent checkout for the same cart fails the claim instead of both
-- proceeding to reserve the same lines. Existing carts start at version 0.
-- The SQLite test harness builds its database from schema.sqlite.prisma
-- (prisma db push), so no harness change is needed for this column.

BEGIN;

ALTER TABLE "Cart" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

COMMIT;
