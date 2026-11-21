-- First-order-only coupon claim (Phase 3, R-1 — D11).
-- Additive only: one flag column on Order + one partial unique index.
-- No existing rows change meaning, and no RLS change is needed (policies
-- are table-level; the new column inherits them).
--
-- *** UNAPPLIED — REQUIRES ANTI'S APPROVAL BEFORE `prisma migrate deploy` ***
-- This migration has NOT been applied to Supabase (or anywhere else). It was
-- created on branch phase3/complete-ecommerce only. Do not deploy it without
-- Anti's explicit go-ahead.
--
-- The problem: the first-order check in code (count non-cancelled orders
-- for the user) is a pre-check only. Two concurrent first orders with
-- DIFFERENT first-order-only coupons both read COUNT=0 and both commit —
-- the per-user redemption index (migration 20261120000006) is keyed on
-- (userId, couponCode), so it cannot see across coupons, and the coupon
-- row's usedCount CAS guards total capacity, not per-user uniqueness.
-- COD placeOrder runs at Read Committed, so Serializable is not even in
-- play there; on the Safepay path Serializable aborts are probabilistic
-- (P2034 under normal concurrency) and not a deterministic fix. The
-- database must be the final guard, and the order row is the commit
-- point, so the claim lives here: at most one non-cancelled order per
-- user may carry a first-order-only coupon.
--
-- How it works:
--   * Order.firstOrderCoupon is set by the checkout services at order
--     creation from Coupon.firstOrderOnly (checkout.service.ts placeOrder
--     via reserveCoupon, safepay-pending-order.service.ts). No other
--     writer sets it; clients never set it.
--   * The partial unique index below enforces one live claim per user.
--     A racing second first order fails its order.create with P2002,
--     which both services detect (isFirstOrderClaimViolation in
--     src/lib/coupon-validation.ts) and report as COUPON_UNAVAILABLE
--     with the existing first-order error — the order is rejected, the
--     coupon is NOT silently dropped, and the order is NOT placed
--     without it.
--   * Cancelling frees the claim because CANCELLED rows leave the index
--     (the same rule as the code check and the per-user index), so
--     cancel-then-redeem needs no backfill change and no cancel-path
--     change; the count pre-check stays as the user-facing error source
--     for sequential (non-race) attempts and for the quote preview.
--
-- Backfill (idempotent): live orders that already redeemed a
-- first-order-only coupon are marked, so the claim is the true record
-- of consumed first-order status from day one. Re-running the UPDATE
-- sets the same values. Users whose first order used no coupon need no
-- row: the count pre-check still rejects their later first-order
-- coupon attempts (priorOrders > 0).
--
-- Pre-existing data: if the database already holds two non-cancelled
-- orders for one user that both redeemed (different) first-order-only
-- coupons, CREATE INDEX fails and this migration rolls back — resolve
-- those duplicates before deploying (cancel all but the earliest, or
-- keep the earliest and cancel the rest). Check first with:
--   SELECT "userId", count(*) FROM "Order"
--    WHERE "firstOrderCoupon" IS TRUE AND "status" <> 'CANCELLED'
--    GROUP BY "userId" HAVING count(*) > 1;
-- (Run against a disposable copy, or read-only against the target;
-- the UPDATE below is what marks the rows, so run the check AFTER a
-- trial deploy to a disposable database, or replicate the UPDATE's
-- predicate: couponCode IN (SELECT code FROM Coupon WHERE
-- firstOrderOnly = true) AND status <> 'CANCELLED'.)
--
-- Mirrored for the SQLite test harness in
-- prisma/sqlite-safepay-test-constraints.sql (partial unique index;
-- the column itself comes from prisma/schema.sqlite.prisma via db push).
-- Prisma cannot express partial indexes, so the index is raw SQL only
-- (no schema @@unique), exactly like migration 20261120000006.
BEGIN;

ALTER TABLE "Order" ADD COLUMN "firstOrderCoupon" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Order" SET "firstOrderCoupon" = true
  WHERE "couponCode" IN (SELECT "code" FROM "Coupon" WHERE "firstOrderOnly" = true)
    AND "status" <> 'CANCELLED';

CREATE UNIQUE INDEX "Order_userId_first_order_coupon_active_idx"
  ON "Order" ("userId")
  WHERE "firstOrderCoupon" IS TRUE AND "status" <> 'CANCELLED';

COMMIT;
