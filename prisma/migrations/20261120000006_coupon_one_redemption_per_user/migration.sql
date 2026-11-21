-- One redemption per user per coupon (Phase 3, Chunk 11 — D11/M-20).
-- Additive only: a single partial unique index, no columns, no data changes.
--
-- The per-user check in code (count non-cancelled orders carrying the coupon
-- code) is a pre-check: under concurrency two checkouts for the same user
-- and coupon can both read zero prior orders before either commits, and the
-- coupon row's usedCount CAS only guards total capacity, not per-user
-- uniqueness — two bare reservations for one user both succeed. The database
-- must be the final guard, and the order row is the commit point, so the
-- index lives here: at most one non-cancelled order per (user, coupon).
-- Cancelling frees the redemption because CANCELLED rows leave the index
-- (the same rule as the code check), so cancel-then-redeem needs no backfill
-- and no reservation-row lifecycle change; COMMITTED reservation rows stay
-- untouched as the durable record.
--
-- NULL userIds never collide (Postgres and SQLite both treat NULLs as
-- distinct in a unique index), so guest orders are unaffected.
-- Mirrored for the SQLite test harness in
-- prisma/sqlite-safepay-test-constraints.sql.
--
-- Pre-existing data: if the production database already holds two
-- non-cancelled orders with the same user and coupon code, this migration
-- fails on CREATE INDEX — resolve those duplicates before deploying.
BEGIN;

CREATE UNIQUE INDEX "Order_userId_couponCode_active_idx"
  ON "Order" ("userId", "couponCode")
  WHERE "couponCode" IS NOT NULL AND "status" <> 'CANCELLED';

COMMIT;
