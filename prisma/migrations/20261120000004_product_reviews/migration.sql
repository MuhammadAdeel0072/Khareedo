-- Product reviews (Phase 3, Chunk 9 — D13).
-- Additive only: one new table (Review). No existing rows change.
-- Product.rating / reviewCount are maintained by in-transaction
-- aggregation over APPROVED reviews (see reviews.service.ts); this
-- migration does NOT rewrite existing rows — products seeded before it
-- keep their (invented) seed values until the first moderation event
-- recomputes them. New seeds are 0/0 (scripts/catalog.ts).
-- RLS mirrors OrderStatusHistory (server-only access, deny by default).

BEGIN;

CREATE TABLE "Review" (
  "id"               TEXT NOT NULL,
  "productId"        TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "rating"           INTEGER NOT NULL,
  "text"             TEXT,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Review_userId_productId_key" ON "Review"("userId", "productId");
CREATE INDEX "Review_productId_status_createdAt_idx" ON "Review"("productId", "status", "createdAt");
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");

ALTER TABLE "Review" ADD CONSTRAINT "Review_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
REVOKE ALL PRIVILEGES ON TABLE public."Review"
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
        'REVOKE ALL PRIVILEGES ON TABLE public."Review" FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$$;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."Review"
ENABLE ROW LEVEL SECURITY;

COMMIT;
