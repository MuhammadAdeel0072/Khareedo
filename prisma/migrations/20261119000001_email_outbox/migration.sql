-- Email outbox (PR-09 security-review fix).
-- Additive only: no existing rows are modified. The forgot-password endpoint
-- enqueues a row here and returns immediately; a background worker delivers
-- the email, so SMTP failures and delivery timing can never reveal whether
-- an account exists. The raw reset token is NOT stored in this table: the
-- worker generates it at delivery time, so the token only ever exists in
-- the worker's memory and in the email itself.

BEGIN;

CREATE TABLE "EmailOutbox" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "userId" TEXT,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON "EmailOutbox"("status", "nextAttemptAt");
CREATE INDEX "EmailOutbox_createdAt_idx" ON "EmailOutbox"("createdAt");

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
REVOKE ALL PRIVILEGES ON TABLE public."EmailOutbox"
FROM PUBLIC, anon, authenticated;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."EmailOutbox"
ENABLE ROW LEVEL SECURITY;

COMMIT;
