-- Safepay Phase 3: TEST-ONLY constraint overlay. NOT EXECUTED.
-- Preconditions: a freshly initialized, marked disposable SQLite database built from
-- prisma/schema.prisma. That schema supplies all columns, foreign keys and indexes.
-- This is NOT an upgrade script for an existing SQLite application database.
-- The guarded test harness installs it after initialization. Do not execute standalone.
-- SQLite INSERT/UPDATE abort triggers mirror PostgreSQL row CHECK predicates without
-- rebuilding/copying existing tables. They never mutate stock, coupon, order or payment data.
-- IS NOT TRUE deliberately rejects SQL NULL, matching CHECK ((predicate) IS TRUE).
-- Safepay signature profiles, provider states and event-ID formats remain unspecified.

BEGIN IMMEDIATE;

-- Match PostgreSQL's owner check. A NULL component otherwise bypasses a composite FK.
CREATE TRIGGER "Order_payment_owner_check_insert"
BEFORE INSERT ON "Order"
FOR EACH ROW
WHEN ((NEW."paymentOwnerOrderId" IS NULL AND NEW."activePaymentId" IS NULL AND NEW."acceptedPaymentId" IS NULL)
  OR (NEW."paymentOwnerOrderId" IS NOT NULL AND NEW."paymentOwnerOrderId" = NEW."id")) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_payment_owner_check');
END;

CREATE TRIGGER "Order_payment_owner_check_update"
BEFORE UPDATE ON "Order"
FOR EACH ROW
WHEN ((NEW."paymentOwnerOrderId" IS NULL AND NEW."activePaymentId" IS NULL AND NEW."acceptedPaymentId" IS NULL)
  OR (NEW."paymentOwnerOrderId" IS NOT NULL AND NEW."paymentOwnerOrderId" = NEW."id")) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_payment_owner_check');
END;

CREATE TRIGGER "Order_version_check_insert"
BEFORE INSERT ON "Order"
FOR EACH ROW
WHEN (NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_version_check');
END;

CREATE TRIGGER "Order_version_check_update"
BEFORE UPDATE ON "Order"
FOR EACH ROW
WHEN (NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_version_check');
END;

CREATE TRIGGER "Order_managed_checkout_check_insert"
BEFORE INSERT ON "Order"
FOR EACH ROW
WHEN (NEW."paymentFlowVersion" IS NULL OR (
    NEW."paymentFlowVersion" > 0 AND NEW."paymentMethod" = 'ONLINE'
    AND NEW."currency" IS NOT NULL AND length(NEW."currency") = 3
    AND NEW."nextPaymentAttempt" IS NOT NULL AND NEW."nextPaymentAttempt" > 0
    AND NEW."checkoutOwnerKind" IS NOT NULL AND length(NEW."checkoutOwnerKind") > 0
    AND NEW."checkoutOwnerHash" IS NOT NULL AND length(NEW."checkoutOwnerHash") > 0
    AND NEW."checkoutFingerprint" IS NOT NULL AND length(NEW."checkoutFingerprint") > 0
    AND NEW."checkoutAccessExpiresAt" IS NOT NULL AND NEW."reservationExpiresAt" IS NOT NULL
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_managed_checkout_check');
END;

CREATE TRIGGER "Order_managed_checkout_check_update"
BEFORE UPDATE ON "Order"
FOR EACH ROW
WHEN (NEW."paymentFlowVersion" IS NULL OR (
    NEW."paymentFlowVersion" > 0 AND NEW."paymentMethod" = 'ONLINE'
    AND NEW."currency" IS NOT NULL AND length(NEW."currency") = 3
    AND NEW."nextPaymentAttempt" IS NOT NULL AND NEW."nextPaymentAttempt" > 0
    AND NEW."checkoutOwnerKind" IS NOT NULL AND length(NEW."checkoutOwnerKind") > 0
    AND NEW."checkoutOwnerHash" IS NOT NULL AND length(NEW."checkoutOwnerHash") > 0
    AND NEW."checkoutFingerprint" IS NOT NULL AND length(NEW."checkoutFingerprint") > 0
    AND NEW."checkoutAccessExpiresAt" IS NOT NULL AND NEW."reservationExpiresAt" IS NOT NULL
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_managed_checkout_check');
END;

CREATE TRIGGER "Order_expiry_lease_check_insert"
BEFORE INSERT ON "Order"
FOR EACH ROW
WHEN ((NEW."expiryLeaseToken" IS NULL AND NEW."expiryLeaseUntil" IS NULL) OR (NEW."expiryLeaseToken" IS NOT NULL AND NEW."expiryLeaseUntil" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_expiry_lease_check');
END;

CREATE TRIGGER "Order_expiry_lease_check_update"
BEFORE UPDATE ON "Order"
FOR EACH ROW
WHEN ((NEW."expiryLeaseToken" IS NULL AND NEW."expiryLeaseUntil" IS NULL) OR (NEW."expiryLeaseToken" IS NOT NULL AND NEW."expiryLeaseUntil" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Order_expiry_lease_check');
END;

CREATE TRIGGER "Payment_counters_check_insert"
BEFORE INSERT ON "Payment"
FOR EACH ROW
WHEN (NEW."version" >= 0 AND NEW."reconcileAttempts" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_counters_check');
END;

CREATE TRIGGER "Payment_counters_check_update"
BEFORE UPDATE ON "Payment"
FOR EACH ROW
WHEN (NEW."version" >= 0 AND NEW."reconcileAttempts" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_counters_check');
END;

CREATE TRIGGER "Payment_managed_attempt_check_insert"
BEFORE INSERT ON "Payment"
FOR EACH ROW
WHEN (NEW."attemptNumber" IS NULL OR (
    NEW."attemptNumber" > 0 AND NEW."provider" = 'SAFEPAY'
    AND NEW."attemptState" IS NOT NULL AND length(NEW."attemptState") > 0
    AND NEW."providerEnvironment" IS NOT NULL AND length(NEW."providerEnvironment") > 0
    AND NEW."merchantAccountRef" IS NOT NULL AND length(NEW."merchantAccountRef") > 0
    AND NEW."currency" IS NOT NULL AND length(NEW."currency") = 3
    AND NEW."expectedAmountMinor" IS NOT NULL AND NEW."expectedAmountMinor" >= 0
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_managed_attempt_check');
END;

CREATE TRIGGER "Payment_managed_attempt_check_update"
BEFORE UPDATE ON "Payment"
FOR EACH ROW
WHEN (NEW."attemptNumber" IS NULL OR (
    NEW."attemptNumber" > 0 AND NEW."provider" = 'SAFEPAY'
    AND NEW."attemptState" IS NOT NULL AND length(NEW."attemptState") > 0
    AND NEW."providerEnvironment" IS NOT NULL AND length(NEW."providerEnvironment") > 0
    AND NEW."merchantAccountRef" IS NOT NULL AND length(NEW."merchantAccountRef") > 0
    AND NEW."currency" IS NOT NULL AND length(NEW."currency") = 3
    AND NEW."expectedAmountMinor" IS NOT NULL AND NEW."expectedAmountMinor" >= 0
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_managed_attempt_check');
END;

CREATE TRIGGER "Payment_tracker_binding_check_insert"
BEFORE INSERT ON "Payment"
FOR EACH ROW
WHEN ((NEW."trackerToken" IS NULL AND NEW."trackerIdentityKey" IS NULL) OR (
    NEW."trackerToken" IS NOT NULL AND length(NEW."trackerToken") > 0
    AND NEW."trackerIdentityKey" IS NOT NULL AND length(NEW."trackerIdentityKey") > 0
    AND NEW."attemptNumber" IS NOT NULL
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_tracker_binding_check');
END;

CREATE TRIGGER "Payment_tracker_binding_check_update"
BEFORE UPDATE ON "Payment"
FOR EACH ROW
WHEN ((NEW."trackerToken" IS NULL AND NEW."trackerIdentityKey" IS NULL) OR (
    NEW."trackerToken" IS NOT NULL AND length(NEW."trackerToken") > 0
    AND NEW."trackerIdentityKey" IS NOT NULL AND length(NEW."trackerIdentityKey") > 0
    AND NEW."attemptNumber" IS NOT NULL
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_tracker_binding_check');
END;

CREATE TRIGGER "Payment_amounts_check_insert"
BEFORE INSERT ON "Payment"
FOR EACH ROW
WHEN ((NEW."expectedAmountMinor" IS NULL OR NEW."expectedAmountMinor" >= 0)
  AND (NEW."capturedAmountMinor" IS NULL OR NEW."capturedAmountMinor" >= 0)
  AND (NEW."refundedAmountMinor" IS NULL OR NEW."refundedAmountMinor" >= 0)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_amounts_check');
END;

CREATE TRIGGER "Payment_amounts_check_update"
BEFORE UPDATE ON "Payment"
FOR EACH ROW
WHEN ((NEW."expectedAmountMinor" IS NULL OR NEW."expectedAmountMinor" >= 0)
  AND (NEW."capturedAmountMinor" IS NULL OR NEW."capturedAmountMinor" >= 0)
  AND (NEW."refundedAmountMinor" IS NULL OR NEW."refundedAmountMinor" >= 0)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_amounts_check');
END;

CREATE TRIGGER "Payment_reconcile_lease_check_insert"
BEFORE INSERT ON "Payment"
FOR EACH ROW
WHEN ((NEW."reconcileLeaseToken" IS NULL AND NEW."reconcileLeaseUntil" IS NULL) OR (NEW."reconcileLeaseToken" IS NOT NULL AND NEW."reconcileLeaseUntil" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_reconcile_lease_check');
END;

CREATE TRIGGER "Payment_reconcile_lease_check_update"
BEFORE UPDATE ON "Payment"
FOR EACH ROW
WHEN ((NEW."reconcileLeaseToken" IS NULL AND NEW."reconcileLeaseUntil" IS NULL) OR (NEW."reconcileLeaseToken" IS NOT NULL AND NEW."reconcileLeaseUntil" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Payment_reconcile_lease_check');
END;

CREATE TRIGGER "Inventory_version_check_insert"
BEFORE INSERT ON "Inventory"
FOR EACH ROW
WHEN (NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Inventory_version_check');
END;

CREATE TRIGGER "Inventory_version_check_update"
BEFORE UPDATE ON "Inventory"
FOR EACH ROW
WHEN (NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Inventory_version_check');
END;

CREATE TRIGGER "Coupon_reservation_counters_check_insert"
BEFORE INSERT ON "Coupon"
FOR EACH ROW
WHEN (NEW."version" >= 0 AND NEW."reservedCount" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Coupon_reservation_counters_check');
END;

CREATE TRIGGER "Coupon_reservation_counters_check_update"
BEFORE UPDATE ON "Coupon"
FOR EACH ROW
WHEN (NEW."version" >= 0 AND NEW."reservedCount" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Coupon_reservation_counters_check');
END;

CREATE TRIGGER "Coupon_reserved_capacity_check_insert"
BEFORE INSERT ON "Coupon"
FOR EACH ROW
WHEN (NEW."reservedCount" = 0 OR (
    NEW."usedCount" >= 0 AND (
      NEW."maxUses" IS NULL OR CAST(NEW."usedCount" AS BIGINT) + NEW."reservedCount" <= NEW."maxUses"
    )
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Coupon_reserved_capacity_check');
END;

CREATE TRIGGER "Coupon_reserved_capacity_check_update"
BEFORE UPDATE ON "Coupon"
FOR EACH ROW
WHEN (NEW."reservedCount" = 0 OR (
    NEW."usedCount" >= 0 AND (
      NEW."maxUses" IS NULL OR CAST(NEW."usedCount" AS BIGINT) + NEW."reservedCount" <= NEW."maxUses"
    )
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'Coupon_reserved_capacity_check');
END;

CREATE TRIGGER "InventoryReservation_quantity_version_check_insert"
BEFORE INSERT ON "InventoryReservation"
FOR EACH ROW
WHEN (NEW."quantity" > 0 AND NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'InventoryReservation_quantity_version_check');
END;

CREATE TRIGGER "InventoryReservation_quantity_version_check_update"
BEFORE UPDATE ON "InventoryReservation"
FOR EACH ROW
WHEN (NEW."quantity" > 0 AND NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'InventoryReservation_quantity_version_check');
END;

CREATE TRIGGER "InventoryReservation_state_check_insert"
BEFORE INSERT ON "InventoryReservation"
FOR EACH ROW
WHEN ((NEW."state" = 'HELD' AND NEW."consumedAt" IS NULL AND NEW."releasedAt" IS NULL AND NEW."restoredAt" IS NULL)
  OR (NEW."state" = 'CONSUMED' AND NEW."consumedAt" IS NOT NULL AND NEW."releasedAt" IS NULL AND NEW."restoredAt" IS NULL)
  OR (NEW."state" = 'RELEASED' AND NEW."consumedAt" IS NULL AND NEW."releasedAt" IS NOT NULL AND NEW."restoredAt" IS NULL)
  OR (NEW."state" = 'RESTORED' AND NEW."consumedAt" IS NOT NULL AND NEW."releasedAt" IS NULL AND NEW."restoredAt" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'InventoryReservation_state_check');
END;

CREATE TRIGGER "InventoryReservation_state_check_update"
BEFORE UPDATE ON "InventoryReservation"
FOR EACH ROW
WHEN ((NEW."state" = 'HELD' AND NEW."consumedAt" IS NULL AND NEW."releasedAt" IS NULL AND NEW."restoredAt" IS NULL)
  OR (NEW."state" = 'CONSUMED' AND NEW."consumedAt" IS NOT NULL AND NEW."releasedAt" IS NULL AND NEW."restoredAt" IS NULL)
  OR (NEW."state" = 'RELEASED' AND NEW."consumedAt" IS NULL AND NEW."releasedAt" IS NOT NULL AND NEW."restoredAt" IS NULL)
  OR (NEW."state" = 'RESTORED' AND NEW."consumedAt" IS NOT NULL AND NEW."releasedAt" IS NULL AND NEW."restoredAt" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'InventoryReservation_state_check');
END;

CREATE TRIGGER "CouponReservation_version_check_insert"
BEFORE INSERT ON "CouponReservation"
FOR EACH ROW
WHEN (NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'CouponReservation_version_check');
END;

CREATE TRIGGER "CouponReservation_version_check_update"
BEFORE UPDATE ON "CouponReservation"
FOR EACH ROW
WHEN (NEW."version" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'CouponReservation_version_check');
END;

CREATE TRIGGER "CouponReservation_state_check_insert"
BEFORE INSERT ON "CouponReservation"
FOR EACH ROW
WHEN ((NEW."state" = 'HELD' AND NEW."committedAt" IS NULL AND NEW."releasedAt" IS NULL)
  OR (NEW."state" = 'COMMITTED' AND NEW."committedAt" IS NOT NULL AND NEW."releasedAt" IS NULL)
  OR (NEW."state" = 'RELEASED' AND NEW."committedAt" IS NULL AND NEW."releasedAt" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'CouponReservation_state_check');
END;

CREATE TRIGGER "CouponReservation_state_check_update"
BEFORE UPDATE ON "CouponReservation"
FOR EACH ROW
WHEN ((NEW."state" = 'HELD' AND NEW."committedAt" IS NULL AND NEW."releasedAt" IS NULL)
  OR (NEW."state" = 'COMMITTED' AND NEW."committedAt" IS NOT NULL AND NEW."releasedAt" IS NULL)
  OR (NEW."state" = 'RELEASED' AND NEW."committedAt" IS NULL AND NEW."releasedAt" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'CouponReservation_state_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_counters_check_insert"
BEFORE INSERT ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN (NEW."deliveryCount" > 0 AND NEW."processingAttempts" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_counters_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_counters_check_update"
BEFORE UPDATE ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN (NEW."deliveryCount" > 0 AND NEW."processingAttempts" >= 0) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_counters_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_lease_check_insert"
BEFORE INSERT ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN ((NEW."leaseToken" IS NULL AND NEW."leaseUntil" IS NULL) OR (NEW."leaseToken" IS NOT NULL AND NEW."leaseUntil" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_lease_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_lease_check_update"
BEFORE UPDATE ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN ((NEW."leaseToken" IS NULL AND NEW."leaseUntil" IS NULL) OR (NEW."leaseToken" IS NOT NULL AND NEW."leaseUntil" IS NOT NULL)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_lease_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_hashes_check_insert"
BEFORE INSERT ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN (length(NEW."firstPayloadSha256") = 64 AND length(NEW."lastPayloadSha256") = 64 AND (NEW."businessPayloadSha256" IS NULL OR length(NEW."businessPayloadSha256") = 64)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_hashes_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_hashes_check_update"
BEFORE UPDATE ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN (length(NEW."firstPayloadSha256") = 64 AND length(NEW."lastPayloadSha256") = 64 AND (NEW."businessPayloadSha256" IS NULL OR length(NEW."businessPayloadSha256") = 64)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_hashes_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_payload_check_insert"
BEFORE INSERT ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN ((
    NEW."payloadPurgedAt" IS NULL
    AND NEW."payloadKeyId" IS NOT NULL AND length(NEW."payloadKeyId") > 0
    AND NEW."payloadCiphertext" IS NOT NULL AND NEW."payloadNonce" IS NOT NULL AND NEW."payloadAuthTag" IS NOT NULL
  ) OR (
    NEW."payloadPurgedAt" IS NOT NULL
    AND NEW."payloadKeyId" IS NULL AND NEW."payloadCiphertext" IS NULL AND NEW."payloadNonce" IS NULL AND NEW."payloadAuthTag" IS NULL
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_payload_check');
END;

CREATE TRIGGER "PaymentWebhookEvent_payload_check_update"
BEFORE UPDATE ON "PaymentWebhookEvent"
FOR EACH ROW
WHEN ((
    NEW."payloadPurgedAt" IS NULL
    AND NEW."payloadKeyId" IS NOT NULL AND length(NEW."payloadKeyId") > 0
    AND NEW."payloadCiphertext" IS NOT NULL AND NEW."payloadNonce" IS NOT NULL AND NEW."payloadAuthTag" IS NOT NULL
  ) OR (
    NEW."payloadPurgedAt" IS NOT NULL
    AND NEW."payloadKeyId" IS NULL AND NEW."payloadCiphertext" IS NULL AND NEW."payloadNonce" IS NULL AND NEW."payloadAuthTag" IS NULL
  )) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentWebhookEvent_payload_check');
END;

CREATE TRIGGER "PaymentEvidence_versions_check_insert"
BEFORE INSERT ON "PaymentEvidence"
FOR EACH ROW
WHEN (NEW."paymentVersion" >= 0 AND (NEW."orderVersion" IS NULL OR NEW."orderVersion" >= 0)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentEvidence_versions_check');
END;

CREATE TRIGGER "PaymentEvidence_versions_check_update"
BEFORE UPDATE ON "PaymentEvidence"
FOR EACH ROW
WHEN (NEW."paymentVersion" >= 0 AND (NEW."orderVersion" IS NULL OR NEW."orderVersion" >= 0)) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentEvidence_versions_check');
END;

CREATE TRIGGER "PaymentEvidence_final_event_check_insert"
BEFORE INSERT ON "PaymentEvidence"
FOR EACH ROW
WHEN (NEW."processedWebhookEventId" IS NULL OR (NEW."sourceWebhookEventId" IS NOT NULL AND NEW."sourceWebhookEventId" = NEW."processedWebhookEventId")) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentEvidence_final_event_check');
END;

CREATE TRIGGER "PaymentEvidence_final_event_check_update"
BEFORE UPDATE ON "PaymentEvidence"
FOR EACH ROW
WHEN (NEW."processedWebhookEventId" IS NULL OR (NEW."sourceWebhookEventId" IS NOT NULL AND NEW."sourceWebhookEventId" = NEW."processedWebhookEventId")) IS NOT TRUE
BEGIN
  SELECT RAISE(ABORT, 'PaymentEvidence_final_event_check');
END;

COMMIT;
