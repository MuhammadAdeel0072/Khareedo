-- Safepay refund ledger: additive persistence authoring only.
-- Preserve legacy values: no backfill, money conversion, UPDATE, DELETE, or table rebuild.
-- Existing Payment/Order rows are untouched; PaymentRefund rows only ever attach to
-- managed payment attempts via RESTRICT foreign keys.
-- Money is integer minor units (BIGINT); never floating point.
-- operationKey is a LOCAL dedup/operation identity. No provider idempotency behavior
-- is assumed; no provider state vocabulary beyond documented tracker states is stored.
-- Explicit transaction keeps schema and server-only permissions atomic.

BEGIN;

CREATE TABLE "PaymentRefund" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "trackerToken" TEXT NOT NULL,
  "providerEnvironment" TEXT NOT NULL,
  "merchantAccountRef" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "initiatedBy" TEXT NOT NULL DEFAULT 'ADMIN',
  "operationKey" TEXT NOT NULL,
  "providerState" TEXT,
  "providerReference" TEXT,
  "providerRefundedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "lastSubmissionCode" TEXT,
  "reviewReason" TEXT,
  "requestedByUserId" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "reconcileStatus" TEXT,
  "nextReconcileAt" TIMESTAMP(3),
  "lastReconcileAt" TIMESTAMP(3),
  "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

-- Additive evidence link: which finalized refund operation an evidence row settled.
ALTER TABLE "PaymentEvidence" ADD COLUMN "refundId" TEXT;

CREATE UNIQUE INDEX "PaymentRefund_operationKey_key" ON "PaymentRefund"("operationKey");
CREATE INDEX "PaymentRefund_paymentId_status_idx" ON "PaymentRefund"("paymentId", "status");
CREATE INDEX "PaymentRefund_status_nextReconcileAt_idx" ON "PaymentRefund"("status", "nextReconcileAt");
CREATE INDEX "PaymentRefund_trackerToken_idx" ON "PaymentRefund"("trackerToken");
CREATE INDEX "PaymentEvidence_refundId_idx" ON "PaymentEvidence"("refundId");

ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "PaymentRefund" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_money_check"
  CHECK (("amountMinor" > 0 AND length("currency") = 3 AND "version" >= 0) IS TRUE);

ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_type_check"
  CHECK (("type" IN ('FULL', 'PARTIAL')) IS TRUE);

ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_initiatedBy_check"
  CHECK (("initiatedBy" IN ('ADMIN', 'PROVIDER')) IS TRUE);

-- Lifecycle: timestamps must exist for the states that assert them.
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_status_check"
  CHECK ((
    "status" IN ('REQUESTED', 'SUBMITTING', 'PENDING', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED')
    AND ("submittedAt" IS NOT NULL OR "status" IN ('REQUESTED', 'REVIEW_REQUIRED'))
    AND ("confirmedAt" IS NULL OR "status" = 'SUCCEEDED')
    AND ("settledAt" IS NULL OR "status" = 'SUCCEEDED')
    AND ("failureCode" IS NULL OR "status" IN ('FAILED', 'PENDING', 'REVIEW_REQUIRED'))
    AND ("reviewReason" IS NULL OR "status" = 'REVIEW_REQUIRED')
  ) IS TRUE);

ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_reconciliation_check"
  CHECK (("reconcileAttempts" >= 0) IS TRUE);

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
-- Keep the financial refund ledger private.
REVOKE ALL PRIVILEGES ON TABLE public."PaymentRefund"
FROM PUBLIC, anon, authenticated;

-- Block direct row access unless explicitly authorized.
ALTER TABLE public."PaymentRefund"
ENABLE ROW LEVEL SECURITY;

COMMIT;
