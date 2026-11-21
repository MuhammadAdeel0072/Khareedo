-- Postgres-only verification seed: REPRESENTATIVE PRE-PHASE-3 DATA.
-- Applied AFTER `prisma migrate deploy` with ONLY the pre-Phase-3 migrations
-- (20261029195900 .. 20261119000004) present, and BEFORE the 9 Phase 3
-- migrations (20261120000000 .. 20261120000008) are applied.
-- Uses ONLY columns that exist pre-Phase-3 (no variantId, cancelledAt,
-- cancelledBy, cancelReason, carrier, trackingNumber, maxDiscountAmount,
-- firstOrderOnly, Promotion.version, Order.promotionId/promotionTitle,
-- Cart.version, EmailOutbox.payload, ProductVariant, Review,
-- OrderStatusHistory).
-- Why direct SQL: the repo seed (scripts/seed.ts -> src/lib/seed.ts) is
-- SQLite-only — it imports generated/sqlite-client and refuses any
-- non-`file:` DATABASE_URL. It cannot run against a partial Postgres schema.
-- IDs are fixed readable strings so before/after spot-checks are exact.
-- No real personal data; all values are synthetic test fixtures.

BEGIN;

INSERT INTO "User" ("id", "email", "passwordHash", "name", "phone", "role", "emailVerified", "createdAt", "updatedAt")
VALUES
  ('pgv-user-admin', 'pgv-admin@example.test', '$2b$10$pgvtesthashadmin0000000000000000000000000000000000', 'PG Verify Admin', '+920000000001', 'ADMIN', '2026-11-01 00:00:00', '2026-11-01 00:00:00', '2026-11-01 00:00:00'),
  ('pgv-user-1', 'pgv-cust1@example.test', '$2b$10$pgvtesthashcust10000000000000000000000000000000000', 'PG Verify Cust One', '+920000000002', 'CUSTOMER', '2026-11-01 00:00:00', '2026-11-01 00:00:00', '2026-11-01 00:00:00'),
  ('pgv-user-2', 'pgv-cust2@example.test', '$2b$10$pgvtesthashcust20000000000000000000000000000000000', 'PG Verify Cust Two', '+920000000003', 'CUSTOMER', '2026-11-01 00:00:00', '2026-11-01 00:00:00', '2026-11-01 00:00:00'),
  ('pgv-user-3', 'pgv-cust3@example.test', NULL, 'PG Verify Cust Three', NULL, 'CUSTOMER', NULL, '2026-11-01 00:00:00', '2026-11-01 00:00:00');

INSERT INTO "Category" ("id", "name", "slug", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES
  ('pgv-cat-electronics', 'PGV Electronics', 'pgv-electronics', 'Seed category one', true, 0, '2026-11-01 00:00:00', '2026-11-01 00:00:00'),
  ('pgv-cat-fashion', 'PGV Fashion', 'pgv-fashion', 'Seed category two', true, 1, '2026-11-01 00:00:00', '2026-11-01 00:00:00');

-- Legacy invented ratings (4.5/12, 3.0/4) on purpose: the Phase 3 review
-- migration must NOT rewrite them; only a later moderation event recomputes.
INSERT INTO "Product" ("id", "name", "slug", "description", "brand", "sku", "categoryId", "price", "comparePrice", "status", "isFeatured", "rating", "reviewCount", "tags", "createdAt", "updatedAt")
VALUES
  ('pgv-prod-phone', 'PGV Phone X', 'pgv-phone-x', 'Seed phone', 'PGV', 'PGV-PHONE-X', 'pgv-cat-electronics', 8999, 10999, 'PUBLISHED', true, 4.5, 12, 'phone', '2026-11-01 00:00:00', '2026-11-01 00:00:00'),
  ('pgv-prod-shirt', 'PGV Shirt', 'pgv-shirt', 'Seed shirt', 'PGV', 'PGV-SHIRT', 'pgv-cat-fashion', 2499, NULL, 'PUBLISHED', false, 3.0, 4, 'shirt', '2026-11-01 00:00:00', '2026-11-01 00:00:00'),
  ('pgv-prod-laptop', 'PGV Laptop', 'pgv-laptop', 'Seed laptop', 'PGV', 'PGV-LAPTOP', 'pgv-cat-electronics', 99999, NULL, 'PUBLISHED', false, 0, 0, 'laptop', '2026-11-01 00:00:00', '2026-11-01 00:00:00');

-- Zero-stock row on purpose: the quantity CHECK (>= 0) must accept 0.
INSERT INTO "Inventory" ("id", "productId", "quantity", "lowStockThreshold", "updatedAt")
VALUES
  ('pgv-inv-phone', 'pgv-prod-phone', 24, 5, '2026-11-01 00:00:00'),
  ('pgv-inv-shirt', 'pgv-prod-shirt', 0, 5, '2026-11-01 00:00:00'),
  ('pgv-inv-laptop', 'pgv-prod-laptop', 7, 2, '2026-11-01 00:00:00');

INSERT INTO "Coupon" ("id", "code", "description", "type", "value", "minOrderAmount", "maxUses", "usedCount", "isActive", "createdAt", "updatedAt", "reservedCount", "version")
VALUES
  ('pgv-coupon-welcome10', 'WELCOME10', 'Seed welcome coupon', 'PERCENT', 10, 0, 100, 3, true, '2026-11-01 00:00:00', '2026-11-01 00:00:00', 0, 0),
  ('pgv-coupon-save20', 'SAVE20', 'Seed fixed coupon', 'FIXED', 500, 1000, 50, 0, true, '2026-11-01 00:00:00', '2026-11-01 00:00:00', 0, 0),
  ('pgv-coupon-expired', 'EXPIRED1', 'Seed inactive coupon', 'PERCENT', 5, 0, NULL, 9, false, '2026-11-01 00:00:00', '2026-11-01 00:00:00', 0, 0);

INSERT INTO "Promotion" ("id", "title", "description", "type", "value", "minOrderAmount", "startsAt", "endsAt", "isActive", "createdAt", "updatedAt")
VALUES
  ('pgv-promo-eid', 'PGV Eid Sale', 'Seed promotion', 'PERCENT', 15, 5000, '2026-11-01 00:00:00', '2026-12-31 23:59:59', true, '2026-11-01 00:00:00', '2026-11-01 00:00:00');

INSERT INTO "Address" ("id", "userId", "label", "fullName", "phone", "line1", "line2", "city", "province", "postalCode", "isDefault", "createdAt", "updatedAt")
VALUES
  ('pgv-addr-1', 'pgv-user-1', 'Home', 'PG Verify Cust One', '+920000000002', '1 Test Street', NULL, 'Lahore', 'Punjab', '54000', true, '2026-11-01 00:00:00', '2026-11-01 00:00:00');

-- Orders in several statuses. pgv-order-cancelled is the key row for the
-- 20261120000006 partial index: a CANCELLED order carrying WELCOME10 must
-- NOT block a later live order for the same user+coupon.
-- pgv-order-coupon-live occupies (pgv-user-1, WELCOME10) as a live order.
INSERT INTO "Order" ("id", "reference", "idempotencyKey", "userId", "isGuest",
  "customerName", "customerEmail", "customerPhone",
  "shipFullName", "shipPhone", "shipLine1", "shipLine2", "shipCity", "shipProvince", "shipPostalCode",
  "status", "paymentMethod", "paymentStatus",
  "subtotal", "discountTotal", "deliveryFee", "deliveryMethod", "giftWrapCharge", "taxTotal", "total",
  "giftWrapSelected", "couponCode", "couponTitle", "notes", "version", "createdAt", "updatedAt")
VALUES
  ('pgv-order-pending',   'KH261101PGV001', 'idem-pgv-pending',   'pgv-user-1', false, 'PG Verify Cust One', 'pgv-cust1@example.test', '+920000000002', 'PG Verify Cust One', '+920000000002', '1 Test Street', NULL, 'Lahore', 'Punjab', '54000', 'PENDING',   'COD', 'PENDING', 8999, 0,   200, 'STANDARD', 0, 0, 9199,  false, NULL, NULL, NULL, 0, '2026-11-10 10:00:00', '2026-11-10 10:00:00'),
  ('pgv-order-confirmed', 'KH261101PGV002', 'idem-pgv-confirmed', 'pgv-user-1', false, 'PG Verify Cust One', 'pgv-cust1@example.test', '+920000000002', 'PG Verify Cust One', '+920000000002', '1 Test Street', NULL, 'Lahore', 'Punjab', '54000', 'CONFIRMED', 'COD', 'PENDING', 2499, 0,   200, 'STANDARD', 0, 0, 2699,  false, NULL, NULL, NULL, 0, '2026-11-10 11:00:00', '2026-11-10 11:00:00'),
  ('pgv-order-shipped',   'KH261101PGV003', 'idem-pgv-shipped',   'pgv-user-2', false, 'PG Verify Cust Two', 'pgv-cust2@example.test', '+920000000003', 'PG Verify Cust Two', '+920000000003', '2 Test Road', NULL, 'Karachi', 'Sindh', '74000', 'SHIPPED',   'COD', 'PENDING', 99999, 0, 0,   'STANDARD', 0, 0, 99999, false, NULL, NULL, NULL, 0, '2026-11-10 12:00:00', '2026-11-10 12:00:00'),
  ('pgv-order-delivered', 'KH261101PGV004', 'idem-pgv-delivered', 'pgv-user-2', false, 'PG Verify Cust Two', 'pgv-cust2@example.test', '+920000000003', 'PG Verify Cust Two', '+920000000003', '2 Test Road', NULL, 'Karachi', 'Sindh', '74000', 'DELIVERED', 'COD', 'PAID',    8999, 900, 200, 'STANDARD', 0, 0, 8299,  false, 'WELCOME10', 'Welcome 10% off', NULL, 0, '2026-11-09 09:00:00', '2026-11-09 09:00:00'),
  ('pgv-order-cancelled', 'KH261101PGV005', 'idem-pgv-cancelled', 'pgv-user-1', false, 'PG Verify Cust One', 'pgv-cust1@example.test', '+920000000002', 'PG Verify Cust One', '+920000000002', '1 Test Street', NULL, 'Lahore', 'Punjab', '54000', 'CANCELLED', 'COD', 'CANCELLED', 8999, 900, 200, 'STANDARD', 0, 0, 8299, false, 'WELCOME10', 'Welcome 10% off', NULL, 0, '2026-11-08 08:00:00', '2026-11-08 08:00:00'),
  ('pgv-order-coupon-live','KH261101PGV006','idem-pgv-couponlive','pgv-user-1', false, 'PG Verify Cust One', 'pgv-cust1@example.test', '+920000000002', 'PG Verify Cust One', '+920000000002', '1 Test Street', NULL, 'Lahore', 'Punjab', '54000', 'CONFIRMED', 'COD', 'PENDING', 8999, 900, 200, 'STANDARD', 0, 0, 8299, false, 'WELCOME10', 'Welcome 10% off', NULL, 0, '2026-11-10 13:00:00', '2026-11-10 13:00:00'),
  ('pgv-order-guest',     'KH261101PGV007', 'idem-pgv-guest',     NULL,         true,  'Guest Buyer', 'pgv-guest@example.test', '+920000000099', 'Guest Buyer', '+920000000099', '9 Guest Lane', NULL, 'Islamabad', 'ICT', '44000', 'PENDING', 'COD', 'PENDING', 2499, 0, 200, 'STANDARD', 0, 0, 2699, false, 'WELCOME10', 'Welcome 10% off', NULL, 0, '2026-11-10 14:00:00', '2026-11-10 14:00:00'),
  ('pgv-order-processing','KH261101PGV008', 'idem-pgv-processing','pgv-user-3', false, 'PG Verify Cust Three', 'pgv-cust3@example.test', '+920000000004', 'PG Verify Cust Three', '+920000000004', '3 Test Ave', NULL, 'Lahore', 'Punjab', '54000', 'PROCESSING','COD', 'PENDING', 2499, 0, 200, 'STANDARD', 0, 0, 2699,  false, NULL, NULL, NULL, 0, '2026-11-10 15:00:00', '2026-11-10 15:00:00');

INSERT INTO "OrderItem" ("id", "orderId", "productId", "productName", "productSlug", "unitPrice", "quantity", "lineTotal", "giftWrap")
VALUES
  ('pgv-oi-1', 'pgv-order-pending',   'pgv-prod-phone',  'PGV Phone X', 'pgv-phone-x', 8999, 1, 8999, false),
  ('pgv-oi-2', 'pgv-order-confirmed', 'pgv-prod-shirt',  'PGV Shirt',   'pgv-shirt',   2499, 1, 2499, false),
  ('pgv-oi-3', 'pgv-order-shipped',   'pgv-prod-laptop', 'PGV Laptop',  'pgv-laptop',  99999, 1, 99999, false),
  ('pgv-oi-4', 'pgv-order-delivered', 'pgv-prod-phone',  'PGV Phone X', 'pgv-phone-x', 8999, 1, 8999, false),
  ('pgv-oi-5', 'pgv-order-cancelled', 'pgv-prod-phone',  'PGV Phone X', 'pgv-phone-x', 8999, 1, 8999, false),
  ('pgv-oi-6', 'pgv-order-coupon-live','pgv-prod-phone','PGV Phone X', 'pgv-phone-x', 8999, 1, 8999, false),
  ('pgv-oi-7', 'pgv-order-guest',     'pgv-prod-shirt',  'PGV Shirt',   'pgv-shirt',   2499, 1, 2499, false),
  ('pgv-oi-8', 'pgv-order-processing','pgv-prod-shirt',  'PGV Shirt',   'pgv-shirt',   2499, 1, 2499, false);

INSERT INTO "Payment" ("id", "orderId", "provider", "amount", "status", "reference", "createdAt", "updatedAt")
VALUES
  ('pgv-pay-pending',   'pgv-order-pending',   'COD', 9199,  'PENDING',   NULL, '2026-11-10 10:00:00', '2026-11-10 10:00:00'),
  ('pgv-pay-delivered', 'pgv-order-delivered', 'COD', 8299,  'PAID',      'COD-PGV-004', '2026-11-09 09:00:00', '2026-11-09 09:00:00'),
  ('pgv-pay-cancelled', 'pgv-order-cancelled', 'COD', 8299,  'CANCELLED', NULL, '2026-11-08 08:00:00', '2026-11-08 08:00:00'),
  ('pgv-pay-shipped',   'pgv-order-shipped',   'COD', 99999, 'PENDING',   NULL, '2026-11-10 12:00:00', '2026-11-10 12:00:00');

INSERT INTO "Cart" ("id", "userId", "sessionKey", "createdAt", "updatedAt")
VALUES
  ('pgv-cart-user1', 'pgv-user-1', NULL, '2026-11-10 10:00:00', '2026-11-10 10:00:00'),
  ('pgv-cart-guest', NULL, 'pgv-sess-1', '2026-11-10 10:00:00', '2026-11-10 10:00:00');

INSERT INTO "CartItem" ("id", "cartId", "productId", "quantity", "giftWrap")
VALUES
  ('pgv-ci-1', 'pgv-cart-user1', 'pgv-prod-phone', 1, false),
  ('pgv-ci-2', 'pgv-cart-user1', 'pgv-prod-shirt', 2, false),
  ('pgv-ci-3', 'pgv-cart-guest', 'pgv-prod-shirt', 1, false);

INSERT INTO "EmailOutbox" ("id", "type", "email", "status", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
VALUES
  ('pgv-outbox-1', 'PASSWORD_RESET', 'pgv-cust1@example.test', 'PENDING', 0, '2026-11-10 10:00:00', '2026-11-10 10:00:00', '2026-11-10 10:00:00');

COMMIT;
