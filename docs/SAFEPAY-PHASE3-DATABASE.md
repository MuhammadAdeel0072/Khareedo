# Safepay Phase 3 database authoring

Status: RELATIONSHIP CORRECTED, MIGRATION NOT APPLIED. Isolated SQLite verification passed.
PostgreSQL execution/access testing remains unverified. Safepay stays disabled; business logic is unchanged.

## Files and scope

- Both Prisma schemas add InventoryReservation, CouponReservation, PaymentWebhookEvent,
  and PaymentEvidence. PostgreSQL generator settings and all existing model fields/indexes
  remain intact.
- PostgreSQL migration: prisma/migrations/20261105000000_safepay_persistence_core/migration.sql.
- SQLite test row invariants: prisma/sqlite-safepay-test-constraints.sql.
- The existing isolated SQLite harness installs that overlay only after creating and
  verifying its marked disposable database. The correction was tested in an isolated copy.

## Data preservation

Existing scalar columns, primary keys, foreign keys, money units, statuses, quantities,
coupon usedCount, and timestamps are unchanged. New lifecycle metadata is nullable.
Only new version/reconciliation/reservation counters receive zero defaults. No old
orders/payments are enrolled, converted, or given fabricated reservation history.

The PostgreSQL SQL is additive and transactional: ALTER ... ADD, four CREATE TABLE
statements, indexes, foreign keys, row CHECK constraints, and server-only REVOKE statements.
There is no data-changing DML, table replacement, or change to existing column definitions.
Legacy rows satisfy the added predicates through NULL workflow metadata and zero counters.

New retained history deliberately blocks destructive deletion of its parents. Existing
CASCADE relations are not rewritten. Once managed reservations exist, old binaries and
cleanup/seed/data-transfer scripts must not bypass their counters or delete their history.

## Model details

Order adds a nullable managed-flow marker, owner binding/fingerprint, attempt counter,
currency, active/accepted pointers, expiration/access timestamps and leases, close/review
metadata, and a zero-initialized version.

Payment remains the payment-attempt record. It adds nullable attempt/tracker/environment/
merchant identity, local retry identity, currency and minor-unit amounts, provider-state
observations, reconciliation scheduling/leases/errors, verified-payment timing, and counters.
The existing Payment.amount and Order money snapshots remain whole PKR. New BigInt amounts
require explicit serialization and boundary validation in later implementation.

The named OrderPayments relation remains the ordinary one-to-many relation. Same-order
active/accepted pointers use (Order.paymentOwnerOrderId, pointer) -> Payment(orderId, id), with:
- Payment unique (orderId, id);
- Payment unique (orderId, attemptNumber), leaving historical attemptNumber NULL;
- Order unique (paymentOwnerOrderId, activePaymentId) and (paymentOwnerOrderId, acceptedPaymentId);
- explicit NO ACTION on the new composite pointer references;
- a row ownership CHECK requiring paymentOwnerOrderId = Order.id when either pointer is present.

The owner field is nullable for historical orders. A null owner is allowed only with both pointers
null; a non-null owner must equal that row\'s id. This closes the nullable composite-FK bypass.
Order.id remains @default(cuid()) and is not a Prisma relation scalar. Using it directly in the
pointer relations suppressed automatic IDs in Prisma 6 runtime tests; the separate owner fixes it.

InventoryReservation is unique per orderItemId and references retained Inventory.
CouponReservation is unique per orderId and references retained Coupon.
Both use state/timestamp shape checks and nonnegative versions. Inventory quantity means
available stock: reserve once, consume without another decrement, release/restore once.

PaymentWebhookEvent has a unique locally constructed dedupKey, an optional matched payment,
processing scheduling/leases, delivery counts, first/last local SHA-256 body digests, encrypted
first payload, retention metadata and opaque signature metadata. Payload ciphertext, nonce,
tag and external key ID must be present together, or all removed with payloadPurgedAt set.
No encryption or signing key material belongs in these tables. Signature profile/encoding,
providerEventId, eventType and eventVersion have no invented defaults or mandatory format.
Provider envelope fields are nullable so an authenticated unsupported event can be quarantined.

PaymentEvidence retains observations, decisions, validation result, relevant versions and
optional source event. A unique processedWebhookEventId permits one final evidence row per
event; other source evidence remains possible. A final event reference must equal its source
reference. Append-only behavior, same-payment event ownership and redaction need service/access
enforcement later; foreign keys alone do not establish them.

PaymentWebhookDelivery, PaymentRefund, provider creation-idempotency fields, authentication
TTL fields, redundant attempt hash identity and evidence basis chains are deferred.

## Checks and portability

The corrected migration adds 22 row CHECK predicates (44 SQLite INSERT/UPDATE triggers). The SQLite overlay contains paired BEFORE INSERT
and BEFORE UPDATE abort triggers with the same predicates, since Prisma db push does not create
custom CHECK constraints. The overlay is only for a fresh test database initialized from the
updated SQLite Prisma schema. It is NOT a migration for an existing SQLite application database.

Both providers obtain the same 23 added unique/ordinary indexes and 10 new foreign keys from
their aligned Prisma declarations. Existing PostgreSQL-only baseline differences are retained.
SQLite FK enforcement is explicitly enabled/checked on the overlay connection; the later
suite must also verify enforcement on Prisma connections.

No state vocabulary from Safepay is hardcoded. Local reservation states are HELD/CONSUMED/
RELEASED/RESTORED and HELD/COMMITTED/RELEASED respectively. SQL validates row shapes, not
cross-row quantities, transition ordering or one-time side effects.

Coupon capacity checks apply only when reservedCount is positive. Thus historical usedCount
and maxUses values are not rejected or rewritten during migration. Every shared writer must
honor usedCount + reservedCount and version before reservations are enabled.

Accepted payment snapshots require nonnegative minor-unit values, but impose no captured/
refunded upper bound against the quote. Evidence observations can retain anomalous values.
Application reconciliation must classify those discrepancies instead of losing the evidence.

The new tables copy the existing REVOKE policy for PUBLIC and, when present, anon and
authenticated roles. This does not introduce or claim RLS/owner immutability. Actual runtime
role privileges must be verified in an isolated PostgreSQL rehearsal.

## Validation boundary

Schema validation/metadata generation and static SQL/schema preservation checks do not prove
SQL execution, physical constraint enforcement, PostgreSQL lock behavior, or concurrency safety.
The original authoring checks were static only. The relationship correction was subsequently
authorized for isolated client generation, fresh SQLite test-schema initialization and tests.
No migration was applied to an existing database; production/Supabase access remains prohibited.

The installed Prisma CLI/client patch versions differ (6.19.3 / 6.19.2). No dependency changes
were made. Both clients generated and application/client TypeScript compilation passed in the
isolated correction workspace using installed native engines.

## Original authoring results (before the relationship correction)

- Installed Prisma 6.19.3 schema validation and metadata generation: PASS for both schemas.
- Existing field definitions retained: 205 per schema; existing index definitions retained.
- Logical model/relation/unique-key parity and all 23 added index definitions: PASS.
- Static SQL coverage: 45 added columns, four new tables, 10 new foreign keys,
  21 PostgreSQL checks and 42 matching SQLite INSERT/UPDATE triggers: PASS.
- Harness syntax check and scoped git diff whitespace check: PASS.
- Hashes of 70 pre-existing changed files outside the authorized edits: unchanged.
- SQL execution, database preservation rehearsal and application/concurrency tests: NOT RUN.

## Relationship correction verification — 2026-11-05

- Added one nullable Order.paymentOwnerOrderId column; the migration now adds 46 columns.
- Corrected both pointer FK/index pairs while keeping 23 new indexes and 10 new FKs.
- Added the PostgreSQL owner CHECK and matching SQLite INSERT/UPDATE checks.
- Both schemas validated; both clients generated only in an isolated copy.
- Application tests: 142/142 passed across 12 files, including 20 permanent relation regressions
  and real COD/bank-transfer checkout service cases without explicit order IDs.
- Targeted database checks: 99/99 passed, covering all 22 predicates on INSERT/UPDATE,
  FKs/indexes/uniqueness, concurrent duplicate writes, rollback and synthetic fixture preservation.
- TypeScript application/client consumers compiled successfully. No packages were changed.
- The disposable harness default now includes the permanent payment-relation suite.
- The auth unit test mocks its unused DB dependency so it never requires application DB settings.
- PostgreSQL migration execution and role restrictions still require a verified disposable local server.

The unexpected untracked prisma/safepay-test-b6c0267765704580bd8988041065aa72.db file was inspected
only through filesystem metadata/ACL and source references. Its origin remains unverified.
It was not opened as a database, read for contents, modified or deleted.

## Remaining isolated verification

1. Rehearse the PostgreSQL migration on a positively verified disposable local PostgreSQL server
   using synthetic legacy fixtures only. Verify data preservation, CHECK/FK behavior and role access.
2. Retain equivalent SQLite checks and run the guarded database suites whenever relations change.
3. Do not apply this migration to an existing Khareedo database or enable payments without approval.
4. Future Safepay service/writer work must separately enforce cross-row counters and transition rules.

## Remaining contract gates

Safepay must confirm signature representation/algorithm/encoding with signed fixtures; stable
event identity and redelivery semantics; supported status/capture/refund schema; token lifetime;
hosted intent/entry mode and capture behavior; tracker creation idempotency and lost-response
lookup; tracker reuse/expiration/late capture; and refund/retry/replay behavior.

These answers govern later service code and key construction. The schema adds no provider API
requests, merchant secrets, provider idempotency promises, assumed token expiry, or enable flags.

## Rollback boundary

Before financial use, an explicitly reviewed rollback can remove empty additions after proving
no managed data exists. After financial activity, retain the additive schema/history. Disable
new online checkout while continuing webhook/reconciliation/expiry processing. Prefer a forward
fix; do not drop evidence, restore a stale database, or revert to reservation-unaware writers.
