# Safepay pending orders and reservations

Status: implemented as internal server services. Public Safepay checkout remains disabled with HTTP 503. No provider requests, application database changes, migrations, package changes or credential changes were made in this phase.

## Atomic creation

`createSafepayPendingOrderService` receives an injected database, the existing server `getSettings` service, the configured environment/account reference, an explicit local reservation duration and a trusted cart/owner context. It does not import or construct the application database. A future authenticated entry point must resolve that context from the server session and HTTP-only cookies; it must not accept it from customer JSON.

The service strictly validates the existing checkout fields with `placeOrderSchema`, requires ONLINE, and rejects additional browser pricing, ownership and redirect fields. Customer/address validation and the existing `computeOrderPricing` and gift-wrap/delivery/coupon calculations are reused. Product prices, visibility, deletion flags, stock, quantities, wrapping flags and coupon capacity come from database records. Unlike a quote preview, an unavailable line aborts payment preparation rather than silently disappearing. There is a local 100-line bound and the existing whole-PKR Int range is respected. No provider amount limit is inferred.

One serializable transaction:

1. Checks the owner-scoped hashed idempotency key and normalized submission fingerprint. Same-key replays return the original order/attempt; changed submissions conflict. Closed/expired submissions cannot be reopened with that key.
2. Locks the owned cart by updating its parent row before reading current lines and products. Registered ownership must match `userId`; a guest must match the server-resolved cart session key and have a separate secure checkout token for the existing owner binding.
3. Validates coupon eligibility, including `usedCount + reservedCount`, and conditionally increments `reservedCount` and coupon version. Invalid coupons abort Safepay preparation; existing offline checkout retains its existing no-discount behavior for an unavailable coupon.
4. Computes server pricing, then conditionally decrements available inventory and increments its version in product-ID order. An insufficient quantity or stale version aborts all writes.
5. Creates a PENDING order with automatic cuid(), immutable whole-PKR item/order snapshots, owner binding, local deadlines, HELD inventory/coupon records, and the existing managed-flow metadata.
6. Creates attempt 1 in READY only after all reservations succeed, stores its separate expected minor-unit amount, assigns same-order composite payment ownership pointers, and records allowlisted local evidence. These writes all remain invisible until the transaction commits.
7. Removes exactly the checked-out cart lines using their IDs, quantities and wrapping flags. A conflicting edit aborts; later/new cart lines are retained. This prevents another request key from checking out the same unchanged cart snapshot. The cart is not automatically repopulated on cancellation.

The original idempotency key and guest tokens are not written to evidence. Transaction serialization/uniqueness aborts can be retried at most twice locally; there is no provider I/O in this transaction. Other contention is reported as BUSY or a safe persistence error without raw diagnostics. A replay returns an existing prepared order; it does not manufacture a new READY attempt or reset an in-flight attempt. The provider store still performs its own eligibility/idempotency checks.

## Inventory and coupon rules

| Operation | Inventory quantity | Inventory reservation | Coupon counters / reservation |
| --- | --- | --- | --- |
| Prepare hosted payment | Decrement available quantity once | Create HELD | Increment reservedCount; create HELD |
| Provider claim/session setup | No quantity change | Keep HELD | No counter change |
| Cancel/expire before any provider claim | Increment once | HELD → RELEASED | Decrement reservedCount once; HELD → RELEASED |
| Cancel/expire with possible provider activity | No quantity change | Retain HELD for review | Retain reservedCount and HELD |
| Verified settlement foundation | No second deduction | HELD → CONSUMED atomically with settlement | reservedCount → usedCount; HELD → COMMITTED |

The verified-settlement rule is now implemented in the internal [payment settlement foundation](PAYMENT-SETTLEMENT.md), behind a verifier registry that remains closed in production. No payment is marked PAID, FAILED or REFUNDED by the reservation services themselves.

Both legacy checkout decrements and cancellation restorations now increment inventory version. Existing COD/bank-transfer orders still use their original deduction and restoration paths; they do not acquire managed reservation metadata. The existing coupon consumption helper now includes held capacity in validation and includes version/reservedCount in its conditional update, so offline orders cannot take held coupon uses.

Absolute admin stock changes use the same inventory-row lock as checkout and refuse changes while any HELD reservation exists. The product editor uses that helper before updating product/images, so a rejected stock change rolls the entire product edit back. New products retain the existing stock initialization. The inventory UI still reports available quantity; a separate reserved-quantity admin display is outside this phase.

Admin coupon edits/deletes lock and version the coupon row. Edits are refused while held and cannot lower a limit below existing usage; deleting a coupon with reservation history is refused. A coupon with released/committed history may be edited/deactivated once no holds remain, while the reservation history remains intact. Routes return a clear conflict response.

## Cancellation, expiration and fulfilment

`createSafepayReservationService.cancel` validates the trusted checkout owner; the existing authorized admin status service delegates managed orders to `updateManagedOrderStatus`. Neither enters the legacy restock/mark-failed branch.

Closure locks/fences Order.version using the same order row as the provider creation claim, then reads every attempt. Only attempts still READY with no creation timestamp, retry claim, tracker or reference may release holds. Mismatched/missing reservations or failed counters cause a full rollback. Release records, counters, order closure, payment lifecycle metadata and evidence commit together. Duplicate closure returns ALREADY_CLOSED and never restores again.

A possibly payable attempt closes customer checkout locally, retains holds, and marks order/payment reconciliation for review. Financial status remains PENDING. Expiration is a local deadline, **not proof that a Safepay tracker is unpayable**. Unknown provider finality therefore cannot trigger an automatic release or replacement attempt. Late success, capture, refunds and safe release after provider activity still require the future verified reconciliation workflow.

`expireBatch` is an explicit internal, bounded service (1–100 rows, default 50), not an enabled scheduler or public endpoint. It scans due PENDING managed orders and uses one serializable closure transaction per order. Concurrent workers are fenced by the order version/status and retry in a later invocation when needed. Closed orders that retain holds require review; they are not silently released on a subsequent batch. A production scheduler, operational alerts and retry/review handling must be wired before activation.

All admin fulfilment stages on managed orders require same-order accepted payment, verified captured amount equal to expected minor amount/order total, no refund, clear review status, and CONSUMED inventory/COMMITTED coupon reservations. A PAID label alone fails. Fulfilment never decrements stock again. Managed paid/consumed-order cancellation is blocked until a refund/restoration policy is implemented. Unpaid legacy ONLINE orders also cannot advance through fulfilment. COD delivery settlement and bank-transfer behavior remain unchanged.

## Validation and deployment limits

- **280/280 tests passed across 15 files**, including the previous 217 and 63 permanent reservation tests.
- Separate Prisma clients compete for the final stock unit, final coupon use and the same submission. Tests also cover same-cart different-key contention and provider claim versus cancellation.
- Injected failures after coupon capacity changes, an earlier inventory decrement/restoration, order creation, payment creation, evidence and cart deletion roll back the entire transaction. Expired setup, missing holds, repeated cancellation, expiry, unsafe fulfilment, admin overwrites and COD/bank-transfer coexistence are covered.
- Both clients were generated only in an isolated source copy. TypeScript and scoped ESLint passed. The unchanged SQLite schema plus its existing constraint overlay was used on freshly created, marked disposable databases, which the guarded harness cleaned up.
- No PostgreSQL transaction/contention execution was performed in this phase. PostgreSQL locking, serializable retry behavior and table permissions still need rehearsal against a positively verified disposable local PostgreSQL database before authorized deployment.
- Both Prisma schemas, authored migration SQL and SQLite overlay are unchanged. Existing application data, money units and settings were not accessed or transformed. The unidentified untracked SQLite file was inspected only for unchanged metadata and was never opened or deleted.
- Destructive maintenance scripts (seed, audit-concurrency, cleanup/import cleanup, manual data transfer) remain offline tools, not reservation-aware application writers. They must remain prohibited against a database with active managed holds, or gain explicit guarded maintenance procedures before such use. This phase does not authorize running them.

## Remaining activation blockers

Safepay merchant profile/PCI entry-mode approval, merchant identity mapping, conflicting authentication-token lifetime/reuse, webhook signed bytes/event identities/retries, authoritative captured/refunded status semantics and provider idempotency/lost-tracker recovery remain unverified. The internal settlement foundation introduces no assumptions about those contracts.

Before connecting a customer entry point: finish verified settlement/reconciliation, late-success and refund/hold resolution; wire a bounded expiration worker and review monitoring; confirm the local reservation duration/abandoned-cart policy; rehearse PostgreSQL and separately authorize schema deployment; then add server session/cart ownership resolution, secure guest cookies, bounded request bodies, CSRF/origin protection, rate limiting, redirect/return handling and customer pending-order UI. Both the public session route and the existing ONLINE placement guard remain disabled.
