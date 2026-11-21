-- Promotions engine + coupon rules (Phase 3, Chunk 11 — D10/D11, M-19/M-20/M-21).
-- Additive only: two nullable/flag columns on Coupon, a version column on
-- Promotion, and two nullable columns on Order. No existing rows change,
-- and no RLS change is needed (policies are table-level; new columns
-- inherit them). No new table: the per-user redemption check keys on
-- non-cancelled Orders carrying the coupon code (see
-- src/lib/coupon-validation.ts), so no redemption model is needed and the
-- COMMITTED-reservation CHECK (CouponReservation_state_check) is untouched.

BEGIN;

ALTER TABLE "Coupon" ADD COLUMN "maxDiscountAmount" INTEGER;
ALTER TABLE "Coupon" ADD COLUMN "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Promotion" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "promotionId" TEXT;
ALTER TABLE "Order" ADD COLUMN "promotionTitle" TEXT;

COMMIT;
