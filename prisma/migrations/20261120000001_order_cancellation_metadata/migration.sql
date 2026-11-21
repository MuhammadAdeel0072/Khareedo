-- Order cancellation metadata (Phase 3, Chunk 2-final — D1/D2).
-- Additive only: three nullable columns on the existing Order table. No
-- existing rows change, and no RLS change is needed (policies are
-- table-level; new columns inherit them).
-- PaymentStatus is a plain string in both Prisma schemas (no Prisma enum,
-- no DB CHECK), so the new CANCELLED payment status needs no DDL — it is
-- enforced in the service layer (PAYMENT_STATUSES in src/lib/constants.ts)
-- exactly like the other values.

BEGIN;

ALTER TABLE "Order" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "Order" ADD COLUMN "cancelReason" TEXT;

COMMIT;
