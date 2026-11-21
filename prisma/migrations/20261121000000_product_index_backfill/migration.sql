-- Product/storefront index backfill + query-support indexes (DB optimisation stream).
-- Additive only: CREATE INDEX IF NOT EXISTS, no columns, no data changes,
-- no index drops or renames. Safe to re-run; safe against a partially
-- applied state.
--
-- *** UNAPPLIED — REQUIRES ANTI'S APPROVAL BEFORE `prisma migrate deploy` ***
-- This migration has NOT been applied to Supabase (or anywhere else). It was
-- created on branch phase3/complete-ecommerce only. Do not deploy it without
-- Anti's explicit go-ahead.
--
-- 1. Schema<->migration drift (HIGH): schema.postgres.prisma has declared
--    @@index([status, deletedAt, categoryId]), @@index([isFeatured, createdAt])
--    and @@index([rating]) on Product since the init migration, but NO
--    migration ever created them (the init migration only created the
--    single-column Product indexes). The storefront hot paths (listProducts,
--    getFeaturedProducts, getNewArrivals, rating sort) therefore run without
--    the composite indexes the schema promises. This migration creates
--    exactly those three, with Prisma's default index names, so a future
--    `prisma migrate diff` stops reporting drift.
-- 2. EmailOutbox @@index([type, email, status]): the enqueue dedup read
--    (email-outbox.service.ts enqueueOutboxEmail: findFirst where type +
--    email + status = PENDING, plus payload when present) had no supporting
--    index — every enqueue scanned PENDING rows. The payload column itself
--    stays unindexed by design (TEXT, never indexed).
-- 3. Order @@index([paymentStatus, createdAt]): dashboard revenue SUMs
--    (reports.service.ts getDashboardStats / getRevenueByDay /
--    getPendingRevenue) filter paymentStatus + createdAt ranges; the existing
--    [status, createdAt] index cannot serve a paymentStatus predicate.
-- 4. OrderItem @@index([productName, productSlug]): getTopSellingProducts
--    groups by (productName, productSlug); previously only [orderId] and
--    [productId] existed.
-- 5. "User" (LOWER("email")) expression index: findUserByEmail
--    (auth-users.service.ts) runs WHERE LOWER("email") = $1, which cannot
--    use the @unique b-tree on email. Prisma cannot express an expression
--    index, so it lives here as raw SQL only (no schema change) and is
--    mirrored for the SQLite harness in
--    prisma/sqlite-safepay-test-constraints.sql.
-- 6. pg_trgm trigram GIN indexes (Stage 2 audit): the storefront search
--    (products.service.ts listProducts) is an OR of %ILIKE% over name /
--    description / brand / tags, which is a sequential scan by
--    construction with no index. One GIN index per searched column with
--    gin_trgm_ops lets the planner BitmapOr the three/four index scans.
--    VERIFIED on disposable Postgres 16.4 with the full migrated schema
--    (all 19 migrations applied) and 50,000 products: the exact OR'd
--    ILIKE shape plans as BitmapOr over Product_name/description/brand
--    _trgm_idx (39ms incl. cold buffers vs 150ms Seq Scan without the
--    indexes, identical 3 rows; single-column ILIKE 7.9ms). At 5,000
--    rows the planner still prefers a Seq Scan — the indexes only pay
--    at scale, which is the point: they are cheap insurance now, not a
--    cost. No code change: Prisma `contains` + mode insensitive already
--    emits ILIKE, which is what the trigram index serves. No SQLite
--    mirror: pg_trgm has no SQLite equivalent and the search code path
--    is unchanged, so the harness needs nothing.
--    EXTENSION: `CREATE EXTENSION IF NOT EXISTS pg_trgm` is allow-listed
--    on Supabase (Dashboard -> Database -> Extensions, or this statement
--    as the postgres user) and is transactional, so it can run inside
--    migrate's transaction; on vanilla Postgres it needs a superuser.
--    Deploy note: if the extension is already enabled from the
--    dashboard, this statement is a no-op.
--
-- Deliberately NOT included (verified first, omitted with reason):
-- - Order(userId, couponCode, status): the partial unique index from
--   migration 20261120000006 ("Order_userId_couponCode_active_idx" on
--   (userId, couponCode) WHERE couponCode IS NOT NULL AND status <>
--   'CANCELLED') already serves the per-user coupon eligibility counts
--   (checkCouponUserEligibility: userId + couponCode + status not
--   CANCELLED). A second index would be redundant.
-- - Promotion index: the table is tiny (a handful of active promotions);
--   a sequential scan is cheaper than index maintenance.
--
-- Lock note: plain CREATE INDEX (not CONCURRENTLY — CONCURRENTLY cannot
-- run inside migrate's transaction) takes a brief SHARE lock on each table
-- while building. On the current catalogue size this is seconds at most;
-- on a much larger Product table, schedule the deploy off-peak.

CREATE INDEX IF NOT EXISTS "Product_status_deletedAt_categoryId_idx" ON "Product"("status", "deletedAt", "categoryId");
CREATE INDEX IF NOT EXISTS "Product_isFeatured_createdAt_idx" ON "Product"("isFeatured", "createdAt");
CREATE INDEX IF NOT EXISTS "Product_rating_idx" ON "Product"("rating");

CREATE INDEX IF NOT EXISTS "EmailOutbox_type_email_status_idx" ON "EmailOutbox"("type", "email", "status");

CREATE INDEX IF NOT EXISTS "Order_paymentStatus_createdAt_idx" ON "Order"("paymentStatus", "createdAt");

CREATE INDEX IF NOT EXISTS "OrderItem_productName_productSlug_idx" ON "OrderItem"("productName", "productSlug");

CREATE INDEX IF NOT EXISTS "User_email_lower_idx" ON "User" (LOWER("email"));

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_description_trgm_idx" ON "Product" USING gin ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_brand_trgm_idx" ON "Product" USING gin ("brand" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_tags_trgm_idx" ON "Product" USING gin ("tags" gin_trgm_ops);
