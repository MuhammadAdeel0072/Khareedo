-- Append-only administrator audit log (PR-12).
-- Additive only: no existing rows are modified. One AdminAuditLog row per
-- security-relevant admin action (MFA lifecycle, product/category/
-- inventory/order/refund/payment/settings changes, exports). The
-- application never updates or deletes these rows; there is no update or
-- delete API for them. adminUserId is nullable with ON DELETE SET NULL so
-- deleting an admin account does not erase history. metadata is minimal
-- structured context (e.g. before/after values) and must never contain
-- passwords, tokens, secrets, TOTP secrets, recovery codes, or payment
-- secrets (the service strips sensitive keys before writing).

BEGIN;

CREATE TABLE "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "adminUserId" TEXT,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "requestId" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_adminUserId_createdAt_idx" ON "AdminAuditLog"("adminUserId", "createdAt");
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_createdAt_idx" ON "AdminAuditLog"("targetType", "targetId", "createdAt");

ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminUserId_fkey"
  FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
REVOKE ALL PRIVILEGES ON TABLE public."AdminAuditLog"
FROM PUBLIC, anon, authenticated;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."AdminAuditLog"
ENABLE ROW LEVEL SECURITY;

COMMIT;
