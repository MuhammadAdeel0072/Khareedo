# Payment settlement, durable evidence and reconciliation foundation

This phase supplies internal server services. Safepay checkout and webhook HTTP handlers remain disabled. The real Safepay verifier and status lookup adapter are not implemented or registered. No provider requests, migrations, production data access, credential changes or package installations are involved.

## Hard verification boundary

`verification-registry.ts` returns no approved adapter in application code. There is no environment switch, database flag, browser field, factory argument or simulation helper that enables a provider. Tests mock this module with an explicitly simulated verifier; the application has no test bypass.

`PaymentVerificationAdapter` separates provider authentication/classification from settlement. A future approved adapter must authenticate the original bytes and documented headers, establish the provider environment and merchant identity/account mapping, bind the order/attempt/tracker/owner, enforce the confirmed event/replay contract, and classify only established financial facts. These obligations are not assertions that Safepay already supplies the corresponding fields. Unknown facts must be rejected or classified for review. No Safepay signature header, signed representation, provider state, event ID, refund meaning or status endpoint is assumed by this interface.

The verifier checks its approved scope against the normalized observation, validates a strict allowlist of fields and mints an opaque object tracked in a private WeakMap. Only that object can enter settlement. Plain JSON, `verified: true`, a TypeScript cast, object copying, serialized proofs, persisted verification flags and browser callbacks cannot mint or restore the capability. Proofs have a five-minute local in-process lifetime, independent of provider token lifetimes or timestamp rules. A process restart requires reauthentication of stored original input, not deserialization of a proof.

The normalized application facts are `CAPTURE_CONFIRMED`, `PENDING`, `UNCERTAIN`, `FAILURE_CONFIRMED`, `REFUND_NOTICE` and `REVIEW_REQUIRED`. They are not Safepay event names or payment statuses. Minor amounts use canonical nonnegative decimal strings bounded by signed 64-bit storage; the service converts them to BigInt. The approved adapter must establish the external merchant identity before any proof is issued. The existing Payment model's local merchant account reference is checked separately during settlement; no new provider identity column or unverified API field was introduced.

## Durable inbox and encryption

The existing `PaymentWebhookEvent` table is the durable inbox for both authenticated webhook deliveries and reconciliation observations. `source` in final PaymentEvidence distinguishes those channels. No schema changes are required.

Input is bounded to 1 MiB of original body bytes and bounded headers. Local SHA-256 digests identify stored bytes and normalized business facts; these hashes do not define the provider's HMAC signed representation. The inbox key scopes an authenticated observation ID to provider, environment, local merchant account and source channel. Unverified input uses a separate body-hash namespace and is quarantined; it cannot collide with an authenticated event identity.

Original input is encrypted using native Node.js AES-256-GCM with a random 96-bit nonce, a 128-bit tag and associated data binding provider, environment, merchant reference, deduplication key and first-body digest. A dedicated key ring and active key ID are injected by a future trusted server composition root. Keys are copied into closures and never serialized, stored with the payload, logged or loaded from application environment files by these modules. Rotation retains old keys for existing ciphertext.

The encrypted envelope retains original body bytes and only authentication headers explicitly named by an approved adapter. Authorization/cookie headers cannot be retained. With no approved verifier, authentication headers are discarded and the body remains quarantined. Provider signature/version columns remain unset until their contract is established. If Safepay's eventual contract needs raw header ordering/duplicates or another representation beyond the current byte-body/header interface, the interface must be revised before approval.

Redelivery increments the delivery counter and last-body digest while retaining the first encrypted envelope. Repeated IDs with identical normalized facts are duplicates. An authenticated ID reused for different facts is quarantined for review; if previously linked to a payment, its order/payment are marked for review without changing money, stock or coupon counts. The first payload remains the forensic baseline; the conflicting delivery is recorded by its last digest and review reason, not by overwriting that payload.

`process` decrypts the first envelope, verifies its digest, reruns the currently approved verifier and presents a new opaque proof to settlement. A missing key, failed authentication tag or unavailable/purged payload moves an unprocessed event to review without financial changes. A revoked/unavailable provider verifier leaves the event unprocessed. `pending` offers bounded work discovery; no public ingestion or scheduler is enabled.

## Atomic settlement and replay rules

One serializable transaction:

1. Requires a live verifier-issued proof matching the durable event's provider, environment, merchant scope, authenticated observation ID, first-body digest, normalized facts and tracker identity.
2. Verifies the managed ONLINE order and its exact payment attempt, same-order ownership field, owner binding, user/guest identity, tracker token and scoped tracker key, bound-creation history, PKR currency and exact expected minor amount. Identity mismatches reject the event without changing the referenced orders/payments.
3. Acquires Order.version before Payment/event writes, matching provider claims, cancellation, expiration and admin fulfilment. Stale versions or serialization failures cause bounded retry of the entire local transaction.
4. Checks order/item arithmetic, active attempt, absence of another accepted payment, pending financial state, clear review state, reservation deadline and exact HELD inventory/coupon records. An incorrect amount, inconsistent reservation, replaced attempt, expired/closed order or conflicting lifecycle requires review.
5. Transfers one coupon use from reservedCount to usedCount and HELD to COMMITTED with version/state conditions. Changes every inventory hold HELD to CONSUMED with version/state conditions. It does not write Inventory.quantity: available stock was already deducted during reservation.
6. Sets the payment's existing financial status to PAID, local attempt state to SETTLED, verified capture amount/time and reconciliation status VERIFIED. Sets order status CONFIRMED, paymentStatus PAID and its same-order accepted payment pointer. It checks the local reservation deadline again before completing; crossing the deadline rolls the entire transaction back for reevaluation.
7. Links/finalizes the inbox event and creates exactly one final PaymentEvidence row using its unique processedWebhookEventId. Event finalization, money, order, holds, coupon counters and evidence commit or roll back together.

Same-event processing is a no-op after completion. A new authenticated observation ID repeating the same accepted capture records an ALREADY_SETTLED decision without consuming again or regressing a PROCESSING/SHIPPED/DELIVERED order. Duplicate webhook and reconciliation observations may both be recorded, but only one can perform the financial transition.

The session-setup review path now locks Order before Payment and refuses to downgrade settled/closed orders, avoiding the previous lock-order inversion with settlement.

## Reconciliation, cancellation, late capture and refunds

| Trusted internal fact | Financial effect | Internal reconciliation / reservations |
| --- | --- | --- |
| PENDING | None | PENDING; keep holds; schedule local retry |
| UNCERTAIN | None | UNCERTAIN; keep holds; schedule local retry |
| Eligible CAPTURE_CONFIRMED | PAID once | VERIFIED; inventory CONSUMED; coupon COMMITTED |
| FAILURE_CONFIRMED before capture | None | FAILED; order requires review; holds retained |
| REVIEW_REQUIRED | None | REVIEW_REQUIRED; no automatic release |
| REFUND_NOTICE | None | REVIEW_REQUIRED; record observed amount; no refund/restoration assumptions |
| Late capture after closure/expiry | None automatically | REVIEW_REQUIRED; no revival or automatic fulfilment |

FAILED is an internal reconciliation state here, not a transition to Payment.status FAILED. No failure observation automatically releases inventory or coupon capacity. A future reviewed contract/policy must authorize terminal-failure release or retry. Review is sticky: verified evidence does not automatically clear an existing anomaly/manual-review flag.

After accepted capture, older pending/uncertain observations with no unexplained financial amounts are recorded without downgrading PAID/VERIFIED. Failure after capture, unexplained financial amounts, inconsistent capture or refund notices require review while retaining the accepted financial record. Refund notices may be partial, full, ambiguous or out of order; their observed amount is preserved in evidence, but refundedAmountMinor is not updated, no refund API is called, no coupon is uncommitted and no stock is restored.

Cancellation/expiry still retain potentially payable holds. Settlement shares their order/version fence: whichever eligible transaction commits first determines the lifecycle. Captures seen after an order closed or its reservation expired do not consume/reacquire released holds, reopen the order or authorize fulfilment. They are recorded for review. Existing paid/consumed managed cancellation remains blocked pending refund/restoration policy.

`createPaymentReconciliationService.observe` accepts only the RECONCILIATION channel through the same authentication/inbox gate. `due` lists bounded, eligible pending/uncertain attempts with a tracker and due local retry time. It does not call any provider status endpoint. The retry delay is explicit local configuration, not a provider retry promise. Work discovery does not grant a network request lease; a future polling adapter must add reviewed request/lease/correlation behavior before actual provider polling is enabled.

## Verification and deployment prerequisites

Permanent tests cover simulated verified capture, registered/guest owners, exact PKR amounts, merchant/tracker/attempt ownership, cross-order attacks, forged/serialized/stale capabilities, hard production gates, duplicate delivery and observation IDs, authenticated ID conflicts, encrypted payload/key rotation/tampering, reconciliation states, late success, refund notices, concurrency, full rollback after partial consumption/coupon transfer and COD/bank-transfer coexistence. Tests use synthetic records in marked disposable SQLite databases. Simulated verifier approval is confined to test module mocks.

The complete isolated suite passed **372/372 tests across 17 files**, including the prior 280 tests and 92 new cases (70 settlement/inbox/reconciliation cases and 22 verification/encryption/gate cases). Both Prisma clients generated successfully in an isolated source copy. TypeScript and scoped ESLint passed. A concurrently edited existing Safepay fixture was preserved and separately revalidated (23/23 tests), followed by successful compilation/lint checks against that current source. PostgreSQL transaction and role-permission execution was not performed; that validation remains a deployment prerequisite.

Remaining requirements before sandbox transactions:

- Safepay confirmation of signed payload bytes/encoding, signature header and key/profile, event identity/replay/retry behavior, authoritative lookup/capture/failure/refund semantics, merchant identity mapping, token lifetime/reuse, tracker timeout/idempotency recovery and hosted entry-mode/PCI approval.
- Implement and explicitly approve real verifier/classification and reconciliation adapters against those contracts. No browser callback may enter this proof path as financial evidence.
- Positively verified disposable PostgreSQL rehearsal for serializable contention, migrations, constraints and role restrictions; separately authorized schema deployment before publishing services that use the authored lifecycle fields.
- Dedicated encryption key custody/rotation, payload retention/purge policy, bounded authenticated ingestion, rate limits/body limits, worker scheduling/retry limits, monitoring and manual review ownership.
- Explicit policies for late capture, terminal failure release, reservation duration, abandonment, refunds and restoration. Full/partial refund execution remains blocked.
- Controlled server session/cart ownership resolution, secure guest cookies, CSRF/origin checks, return handling and customer pending-order UI. Public checkout and webhook gates remain disabled until all activation prerequisites pass review.

Both Prisma schemas, PostgreSQL migration authoring and SQLite constraint overlay are unchanged. Existing COD/bank-transfer implementations, customer UI and performance functionality are preserved.
