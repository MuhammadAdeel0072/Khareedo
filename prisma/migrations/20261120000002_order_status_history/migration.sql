-- Order status history + shipment tracking (Phase 3, Chunk 6 — M-6/D4).
-- Additive only: two nullable columns on Order, one new table. No existing
-- rows change. OrderStatusHistory is append-only (no update/delete API);
-- RLS mirrors AdminAuditLog (server-only access, deny by default).

BEGIN;

ALTER TABLE "Order" ADD COLUMN "carrier" TEXT;
ALTER TABLE "Order" ADD COLUMN "trackingNumber" TEXT;

CREATE TABLE "OrderStatusHistory" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "actor" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");

ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
REVOKE ALL PRIVILEGES ON TABLE public."OrderStatusHistory"
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
        'REVOKE ALL PRIVILEGES ON TABLE public."OrderStatusHistory" FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$$;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."OrderStatusHistory"
ENABLE ROW LEVEL SECURITY;

COMMIT;
