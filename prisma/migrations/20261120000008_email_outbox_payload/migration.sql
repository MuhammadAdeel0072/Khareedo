-- Email outbox payload (Phase 3, Chunk 7-final — D14/H-14).
-- Additive only: one nullable column; no existing rows change.
-- Order notification rows carry the data the worker needs to render the
-- email (order id/reference/total/status, refund amount) as JSON; the row's
-- own email column is the recipient. Verification rows may carry a
-- callbackUrl here — the Chunk 7 (M-24) caveat that verification links
-- always landed on "/account" is fixed by the same column: the worker
-- reads payload.callbackUrl when present.
-- The SQLite test harness builds its database from schema.sqlite.prisma
-- (prisma db push), so no harness change is needed for this column.

BEGIN;

ALTER TABLE "EmailOutbox" ADD COLUMN "payload" TEXT;

COMMIT;
