-- Product variants (Phase 3, Chunk 8 — D12).
-- Additive only: one new table (ProductVariant), one nullable column on
-- Inventory (variantId), one nullable column on CartItem (variantId), three
-- nullable columns on OrderItem (variantId, variantLabel, variantSku). No
-- existing rows change: every existing Inventory row is the product-level
-- row (variantId NULL), every existing cart/order line is the product
-- itself (variantId NULL). No backfill.
--
-- Uniqueness note: Postgres and SQLite both treat NULLs as distinct in a
-- plain unique index, so the (productId, variantId) compound unique does
-- NOT stop two product-level rows for one product, and the
-- (cartId, productId, variantId) compound unique does NOT stop two
-- no-variant lines for one product in one cart. The two partial unique
-- indexes below close exactly that hole (mirrored for the SQLite test
-- harness in prisma/sqlite-safepay-test-constraints.sql).
-- RLS mirrors OrderStatusHistory (server-only access, deny by default).

BEGIN;

CREATE TABLE "ProductVariant" (
  "id"            TEXT NOT NULL,
  "productId"     TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "sku"           TEXT NOT NULL,
  "priceOverride" INTEGER,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");
CREATE INDEX "ProductVariant_productId_sortOrder_idx" ON "ProductVariant"("productId", "sortOrder");

ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
REVOKE ALL PRIVILEGES ON TABLE public."ProductVariant"
FROM PUBLIC;

-- anon / authenticated are Supabase roles: guard the revoke so this
-- migration also applies on a vanilla PostgreSQL without them
-- (same guarded pattern as 20261029200000 and 20261105000000).
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public."ProductVariant" FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$$;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."ProductVariant"
ENABLE ROW LEVEL SECURITY;

-- Inventory: one row per (productId, variantId). Drop the old productId-only
-- unique index first — it would forbid a second row for a product that gains
-- variants.
ALTER TABLE "Inventory" ADD COLUMN "variantId" TEXT;

DROP INDEX "Inventory_productId_key";

CREATE UNIQUE INDEX "Inventory_productId_variantId_key" ON "Inventory"("productId", "variantId");
CREATE UNIQUE INDEX "Inventory_productId_null_variant_key" ON "Inventory"("productId") WHERE "variantId" IS NULL;
-- Standalone unique on variantId: mirrors the schema's `variantId @unique`
-- (the ProductVariant <-> Inventory 1:1 relation) and matches what the
-- SQLite harness gets from `db push`. Postgres treats NULLs as distinct in
-- a unique index, so the null-variant rows are unaffected; the partial
-- index above still governs one null-variant row per product. Without it
-- the same variant could be linked from two rows under different
-- productIds (the FK alone does not prevent that).
CREATE UNIQUE INDEX "Inventory_variantId_key" ON "Inventory"("variantId");
CREATE INDEX "Inventory_variantId_idx" ON "Inventory"("variantId");

ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CartItem: one line per (cartId, productId, variantId). Same partial-index
-- hole for the no-variant line as Inventory above.
ALTER TABLE "CartItem" ADD COLUMN "variantId" TEXT;

DROP INDEX "CartItem_cartId_productId_key";

CREATE UNIQUE INDEX "CartItem_cartId_productId_variantId_key" ON "CartItem"("cartId", "productId", "variantId");
CREATE UNIQUE INDEX "CartItem_cartId_productId_null_variant_key" ON "CartItem"("cartId", "productId") WHERE "variantId" IS NULL;
CREATE INDEX "CartItem_variantId_idx" ON "CartItem"("variantId");

ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- OrderItem: variant snapshot columns. The FK is SET NULL: deleting a
-- variant must never delete order history — the snapshot (label/sku/price)
-- survives on the line.
ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "variantLabel" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "variantSku" TEXT;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
