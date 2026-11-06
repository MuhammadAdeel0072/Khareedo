-- Safepay Phase 3: additive persistence authoring only. NOT APPLIED.
-- Preserve legacy values: no backfill, money conversion, UPDATE, DELETE, or table rebuild.
-- NULL paymentFlowVersion/attemptNumber distinguish historical/offline records.
-- No provider state enum, token lifetime, signature profile, or provider idempotency assumed.
-- Keep Safepay disabled until every shared writer and provider contract is ready.
-- Row checks are mirrored in prisma/sqlite-safepay-test-constraints.sql.
-- Explicit transaction keeps schema and server-only permissions atomic.

BEGIN;

-- Existing tables: new lifecycle fields are nullable; new counters default to zero.
ALTER TABLE "Order"
  ADD COLUMN "paymentFlowVersion" INTEGER,
  ADD COLUMN "nextPaymentAttempt" INTEGER,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "checkoutOwnerKind" TEXT,
  ADD COLUMN "checkoutOwnerHash" TEXT,
  ADD COLUMN "checkoutFingerprint" TEXT,
  ADD COLUMN "paymentOwnerOrderId" TEXT,
  ADD COLUMN "activePaymentId" TEXT,
  ADD COLUMN "acceptedPaymentId" TEXT,
  ADD COLUMN "checkoutCloseReason" TEXT,
  ADD COLUMN "paymentReviewStatus" TEXT,
  ADD COLUMN "paymentReviewReason" TEXT,
  ADD COLUMN "expiryLeaseToken" TEXT,
  ADD COLUMN "checkoutAccessExpiresAt" TIMESTAMP(3),
  ADD COLUMN "reservationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "checkoutClosedAt" TIMESTAMP(3),
  ADD COLUMN "expiryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Payment"
  ADD COLUMN "attemptNumber" INTEGER,
  ADD COLUMN "attemptState" TEXT,
  ADD COLUMN "providerEnvironment" TEXT,
  ADD COLUMN "merchantAccountRef" TEXT,
  ADD COLUMN "trackerToken" TEXT,
  ADD COLUMN "providerState" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "reconcileStatus" TEXT,
  ADD COLUMN "reconcileLeaseToken" TEXT,
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "providerStateObservedAt" TIMESTAMP(3),
  ADD COLUMN "creationStartedAt" TIMESTAMP(3),
  ADD COLUMN "trackerBoundAt" TIMESTAMP(3),
  ADD COLUMN "paidVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "nextReconcileAt" TIMESTAMP(3),
  ADD COLUMN "lastReconcileAt" TIMESTAMP(3),
  ADD COLUMN "reconcileLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastErrorAt" TIMESTAMP(3),
  ADD COLUMN "expectedAmountMinor" BIGINT,
  ADD COLUMN "capturedAmountMinor" BIGINT,
  ADD COLUMN "refundedAmountMinor" BIGINT,
  ADD COLUMN "retryRequestKey" TEXT,
  ADD COLUMN "trackerIdentityKey" TEXT,
  ADD COLUMN "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Inventory"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Coupon"
  ADD COLUMN "reservedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- New history tables; cuid() IDs and updatedAt are supplied by Prisma, as in existing models.
CREATE TABLE "InventoryReservation" (
  "id" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "inventoryId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'HELD',
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "restoredAt" TIMESTAMP(3),
  "releaseReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CouponReservation" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "couponId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'HELD',
  "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releaseReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "CouponReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'SAFEPAY',
  "providerEnvironment" TEXT NOT NULL,
  "merchantAccountRef" TEXT NOT NULL,
  "providerEventId" TEXT,
  "eventType" TEXT,
  "eventVersion" TEXT,
  "dedupKey" TEXT NOT NULL,
  "trackerToken" TEXT,
  "trackerIdentityKey" TEXT,
  "paymentId" TEXT,
  "businessPayloadSha256" TEXT,
  "leaseToken" TEXT,
  "lastErrorCode" TEXT,
  "reviewReason" TEXT,
  "providerOccurredAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "firstReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveryCount" INTEGER NOT NULL DEFAULT 1,
  "processingStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
  "processingAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextProcessAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewRequired" BOOLEAN NOT NULL DEFAULT FALSE,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "firstPayloadSha256" TEXT NOT NULL,
  "lastPayloadSha256" TEXT NOT NULL,
  "payloadFormat" TEXT,
  "normalizedPayloadJson" TEXT,
  "payloadKeyId" TEXT,
  "signatureProfile" TEXT,
  "signingKeyId" TEXT,
  "signatureValue" TEXT,
  "payloadCiphertext" BYTEA,
  "payloadNonce" BYTEA,
  "payloadAuthTag" BYTEA,
  "payloadPurgedAt" TIMESTAMP(3),
  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentEvidence" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "validationStatus" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "sourceWebhookEventId" TEXT,
  "providerRequestId" TEXT,
  "providerContractVersion" TEXT,
  "observedProviderState" TEXT,
  "observedCurrency" TEXT,
  "rawPayloadSha256" TEXT,
  "reasonCode" TEXT,
  "actorUserIdSnapshot" TEXT,
  "detailsJson" TEXT,
  "processedWebhookEventId" TEXT,
  "providerOccurredAt" TIMESTAMP(3),
  "observedQuoteMinor" BIGINT,
  "observedCapturedMinor" BIGINT,
  "observedRefundedMinor" BIGINT,
  "paymentVersion" INTEGER NOT NULL,
  "orderVersion" INTEGER,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentEvidence_pkey" PRIMARY KEY ("id")
);

-- Referenced composite payment key precedes Order pointer foreign keys.
CREATE UNIQUE INDEX "Payment_orderId_id_key" ON "Payment"("orderId", "id");

-- Defining-side uniqueness, identities, and worker indexes.
CREATE UNIQUE INDEX "Order_paymentOwnerOrderId_activePaymentId_key" ON "Order"("paymentOwnerOrderId", "activePaymentId");
CREATE UNIQUE INDEX "Order_paymentOwnerOrderId_acceptedPaymentId_key" ON "Order"("paymentOwnerOrderId", "acceptedPaymentId");
CREATE INDEX "Order_paymentFlowVersion_status_reservationExpiresAt_idx" ON "Order"("paymentFlowVersion", "status", "reservationExpiresAt");
CREATE INDEX "Order_paymentFlowVersion_paymentReviewStatus_updatedAt_idx" ON "Order"("paymentFlowVersion", "paymentReviewStatus", "updatedAt");
CREATE UNIQUE INDEX "Payment_retryRequestKey_key" ON "Payment"("retryRequestKey");
CREATE UNIQUE INDEX "Payment_trackerIdentityKey_key" ON "Payment"("trackerIdentityKey");
CREATE UNIQUE INDEX "Payment_orderId_attemptNumber_key" ON "Payment"("orderId", "attemptNumber");
CREATE INDEX "Payment_provider_reconcileStatus_nextReconcileAt_idx" ON "Payment"("provider", "reconcileStatus", "nextReconcileAt");
CREATE INDEX "Payment_reconcileStatus_reconcileLeaseUntil_idx" ON "Payment"("reconcileStatus", "reconcileLeaseUntil");
CREATE UNIQUE INDEX "InventoryReservation_orderItemId_key" ON "InventoryReservation"("orderItemId");
CREATE INDEX "InventoryReservation_inventoryId_state_idx" ON "InventoryReservation"("inventoryId", "state");
CREATE UNIQUE INDEX "CouponReservation_orderId_key" ON "CouponReservation"("orderId");
CREATE INDEX "CouponReservation_couponId_state_idx" ON "CouponReservation"("couponId", "state");
CREATE UNIQUE INDEX "PaymentWebhookEvent_dedupKey_key" ON "PaymentWebhookEvent"("dedupKey");
CREATE INDEX "PaymentWebhookEvent_processingStatus_nextProcessAt_idx" ON "PaymentWebhookEvent"("processingStatus", "nextProcessAt");
CREATE INDEX "PaymentWebhookEvent_processingStatus_leaseUntil_idx" ON "PaymentWebhookEvent"("processingStatus", "leaseUntil");
CREATE INDEX "PaymentWebhookEvent_paymentId_firstReceivedAt_idx" ON "PaymentWebhookEvent"("paymentId", "firstReceivedAt");
CREATE INDEX "PaymentWebhookEvent_trackerIdentityKey_idx" ON "PaymentWebhookEvent"("trackerIdentityKey");
CREATE INDEX "PaymentWebhookEvent_reviewRequired_firstReceivedAt_idx" ON "PaymentWebhookEvent"("reviewRequired", "firstReceivedAt");
CREATE UNIQUE INDEX "PaymentEvidence_processedWebhookEventId_key" ON "PaymentEvidence"("processedWebhookEventId");
CREATE INDEX "PaymentEvidence_paymentId_recordedAt_id_idx" ON "PaymentEvidence"("paymentId", "recordedAt", "id");
CREATE INDEX "PaymentEvidence_sourceWebhookEventId_idx" ON "PaymentEvidence"("sourceWebhookEventId");

-- All parents now exist. New retained history uses restrictive deletion behavior.
ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentOwnerOrderId_activePaymentId_fkey"
  FOREIGN KEY ("paymentOwnerOrderId", "activePaymentId") REFERENCES "Payment" ("orderId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentOwnerOrderId_acceptedPaymentId_fkey"
  FOREIGN KEY ("paymentOwnerOrderId", "acceptedPaymentId") REFERENCES "Payment" ("orderId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_inventoryId_fkey"
  FOREIGN KEY ("inventoryId") REFERENCES "Inventory" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "CouponReservation" ADD CONSTRAINT "CouponReservation_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "CouponReservation" ADD CONSTRAINT "CouponReservation_couponId_fkey"
  FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_sourceWebhookEventId_fkey"
  FOREIGN KEY ("sourceWebhookEventId") REFERENCES "PaymentWebhookEvent" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_processedWebhookEventId_fkey"
  FOREIGN KEY ("processedWebhookEventId") REFERENCES "PaymentWebhookEvent" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Local row invariants only: lifecycle transitions and cross-row ownership still need services.
-- Observed evidence amounts are intentionally unrestricted so anomalies can be retained.
-- Captured/refunded snapshots have no expected-amount ceiling; unexpected money needs review.
-- Coupon capacity applies only while a new hold exists, preserving historical usedCount.
-- Nullable composite FKs alone permit a NULL-owner bypass. Require a matching row owner;
-- leave the primary key out of Prisma relation fields so automatic cuid() generation works.
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_owner_check"
  CHECK ((("paymentOwnerOrderId" IS NULL AND "activePaymentId" IS NULL AND "acceptedPaymentId" IS NULL)
    OR ("paymentOwnerOrderId" IS NOT NULL AND "paymentOwnerOrderId" = "id")) IS TRUE);

ALTER TABLE "Order" ADD CONSTRAINT "Order_version_check"
  CHECK (("version" >= 0) IS TRUE);

ALTER TABLE "Order" ADD CONSTRAINT "Order_managed_checkout_check"
  CHECK (("paymentFlowVersion" IS NULL OR (
    "paymentFlowVersion" > 0 AND "paymentMethod" = 'ONLINE'
    AND "currency" IS NOT NULL AND length("currency") = 3
    AND "nextPaymentAttempt" IS NOT NULL AND "nextPaymentAttempt" > 0
    AND "checkoutOwnerKind" IS NOT NULL AND length("checkoutOwnerKind") > 0
    AND "checkoutOwnerHash" IS NOT NULL AND length("checkoutOwnerHash") > 0
    AND "checkoutFingerprint" IS NOT NULL AND length("checkoutFingerprint") > 0
    AND "checkoutAccessExpiresAt" IS NOT NULL AND "reservationExpiresAt" IS NOT NULL
  )) IS TRUE);

ALTER TABLE "Order" ADD CONSTRAINT "Order_expiry_lease_check"
  CHECK ((("expiryLeaseToken" IS NULL AND "expiryLeaseUntil" IS NULL) OR ("expiryLeaseToken" IS NOT NULL AND "expiryLeaseUntil" IS NOT NULL)) IS TRUE);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_counters_check"
  CHECK (("version" >= 0 AND "reconcileAttempts" >= 0) IS TRUE);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_managed_attempt_check"
  CHECK (("attemptNumber" IS NULL OR (
    "attemptNumber" > 0 AND "provider" = 'SAFEPAY'
    AND "attemptState" IS NOT NULL AND length("attemptState") > 0
    AND "providerEnvironment" IS NOT NULL AND length("providerEnvironment") > 0
    AND "merchantAccountRef" IS NOT NULL AND length("merchantAccountRef") > 0
    AND "currency" IS NOT NULL AND length("currency") = 3
    AND "expectedAmountMinor" IS NOT NULL AND "expectedAmountMinor" >= 0
  )) IS TRUE);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tracker_binding_check"
  CHECK ((("trackerToken" IS NULL AND "trackerIdentityKey" IS NULL) OR (
    "trackerToken" IS NOT NULL AND length("trackerToken") > 0
    AND "trackerIdentityKey" IS NOT NULL AND length("trackerIdentityKey") > 0
    AND "attemptNumber" IS NOT NULL
  )) IS TRUE);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amounts_check"
  CHECK ((("expectedAmountMinor" IS NULL OR "expectedAmountMinor" >= 0)
  AND ("capturedAmountMinor" IS NULL OR "capturedAmountMinor" >= 0)
  AND ("refundedAmountMinor" IS NULL OR "refundedAmountMinor" >= 0)) IS TRUE);

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reconcile_lease_check"
  CHECK ((("reconcileLeaseToken" IS NULL AND "reconcileLeaseUntil" IS NULL) OR ("reconcileLeaseToken" IS NOT NULL AND "reconcileLeaseUntil" IS NOT NULL)) IS TRUE);

ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_version_check"
  CHECK (("version" >= 0) IS TRUE);

ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_reservation_counters_check"
  CHECK (("version" >= 0 AND "reservedCount" >= 0) IS TRUE);

ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_reserved_capacity_check"
  CHECK (("reservedCount" = 0 OR (
    "usedCount" >= 0 AND (
      "maxUses" IS NULL OR CAST("usedCount" AS BIGINT) + "reservedCount" <= "maxUses"
    )
  )) IS TRUE);

ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_quantity_version_check"
  CHECK (("quantity" > 0 AND "version" >= 0) IS TRUE);

ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_state_check"
  CHECK ((("state" = 'HELD' AND "consumedAt" IS NULL AND "releasedAt" IS NULL AND "restoredAt" IS NULL)
  OR ("state" = 'CONSUMED' AND "consumedAt" IS NOT NULL AND "releasedAt" IS NULL AND "restoredAt" IS NULL)
  OR ("state" = 'RELEASED' AND "consumedAt" IS NULL AND "releasedAt" IS NOT NULL AND "restoredAt" IS NULL)
  OR ("state" = 'RESTORED' AND "consumedAt" IS NOT NULL AND "releasedAt" IS NULL AND "restoredAt" IS NOT NULL)) IS TRUE);

ALTER TABLE "CouponReservation" ADD CONSTRAINT "CouponReservation_version_check"
  CHECK (("version" >= 0) IS TRUE);

ALTER TABLE "CouponReservation" ADD CONSTRAINT "CouponReservation_state_check"
  CHECK ((("state" = 'HELD' AND "committedAt" IS NULL AND "releasedAt" IS NULL)
  OR ("state" = 'COMMITTED' AND "committedAt" IS NOT NULL AND "releasedAt" IS NULL)
  OR ("state" = 'RELEASED' AND "committedAt" IS NULL AND "releasedAt" IS NOT NULL)) IS TRUE);

ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_counters_check"
  CHECK (("deliveryCount" > 0 AND "processingAttempts" >= 0) IS TRUE);

ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_lease_check"
  CHECK ((("leaseToken" IS NULL AND "leaseUntil" IS NULL) OR ("leaseToken" IS NOT NULL AND "leaseUntil" IS NOT NULL)) IS TRUE);

ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_hashes_check"
  CHECK ((length("firstPayloadSha256") = 64 AND length("lastPayloadSha256") = 64 AND ("businessPayloadSha256" IS NULL OR length("businessPayloadSha256") = 64)) IS TRUE);

ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_payload_check"
  CHECK (((
    "payloadPurgedAt" IS NULL
    AND "payloadKeyId" IS NOT NULL AND length("payloadKeyId") > 0
    AND "payloadCiphertext" IS NOT NULL AND "payloadNonce" IS NOT NULL AND "payloadAuthTag" IS NOT NULL
  ) OR (
    "payloadPurgedAt" IS NOT NULL
    AND "payloadKeyId" IS NULL AND "payloadCiphertext" IS NULL AND "payloadNonce" IS NULL AND "payloadAuthTag" IS NULL
  )) IS TRUE);

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_versions_check"
  CHECK (("paymentVersion" >= 0 AND ("orderVersion" IS NULL OR "orderVersion" >= 0)) IS TRUE);

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_final_event_check"
  CHECK (("processedWebhookEventId" IS NULL OR ("sourceWebhookEventId" IS NOT NULL AND "sourceWebhookEventId" = "processedWebhookEventId")) IS TRUE);

-- Match existing server-only access policy; no browser/anonymous/authenticated table grants.
REVOKE ALL PRIVILEGES ON TABLE
  "InventoryReservation", "CouponReservation", "PaymentWebhookEvent", "PaymentEvidence"
FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE
          "InventoryReservation", "CouponReservation", "PaymentWebhookEvent", "PaymentEvidence"
         FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$$;

COMMIT;
