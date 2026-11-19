-- MFA session binding (Phase 2, area B — M-4).
-- Additive only: one nullable column on the existing AdminMfa table. No
-- existing rows are modified; NULL means the admin has never verified MFA
-- in a session-bound way, and the guard fails closed for those sessions
-- (the admin re-verifies once, which binds the current session).
-- No RLS change: this alters a column on a table whose RLS state is
-- already set by migration 20261119000002_admin_mfa.

BEGIN;

ALTER TABLE "AdminMfa" ADD COLUMN "lastVerifiedSessionId" TEXT;

COMMIT;
