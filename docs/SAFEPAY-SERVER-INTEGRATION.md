# Safepay server integration — inactive preparation

Status: documented server primitives and durable attempt orchestration implemented.
The public endpoint always returns 503. No setting/environment variable enables it.
No migration, real provider call, settlement, fulfilment or customer UI activation is part of this phase.

## Contract sources and implementation boundary

- [Express Checkout](https://safepay-docs.netlify.app/build-your-integration/express-checkout/)
  and [API reference](https://apidocs.getsafepay.com/) document merchant-secret authentication,
  POST /order/payments/v3/, POST /client/passport/v1/token, and the tracker/token response envelopes.
- [Money](https://safepay-docs.netlify.app/concepts/money/) defines PKR minor units as paisas.
  Existing whole-PKR snapshots are unchanged; outbound values are converted and bounded to exact JSON integers.
- [Intents](https://safepay-docs.netlify.app/concepts/payment-intents/) and
  [modes](https://safepay-docs.netlify.app/concepts/payment-modes/) support CYBERSOURCE/payment.
  Card capability must be true in the creation response.
- [Entry modes](https://safepay-docs.netlify.app/concepts/payment-entry-modes/) documents flex/raw.
  Its raw PCI requirement differs materially from the hosted-guide raw example. No mode is defaulted;
  the merchant-approved hosted profile and PCI responsibilities must be confirmed before activation.
- [Official SDK URL builder](https://github.com/getsafepay/node-core/blob/main/src/Checkout.ts)
  establishes /embedded/ on sandbox.api.getsafepay.com for sandbox and getsafepay.com for production.
  These differ from API origins. Native URL/URLSearchParams reproduce the documented query fields.
  The installed SDK is not imported: its method surface differs from guide examples.

Only the documented creation shape is accepted. Tracker token, environment, intent, mode, entry mode,
quote currency/amount and card capability are validated. TRACKER_STARTED is accepted for creation;
this is not payment success. No provider state is mapped to PAID/FAILED/REFUNDED.

The response client field is a string in creation examples and an expanded merchant object in
[tracker documentation](https://safepay-docs.netlify.app/concepts/tracker/). Its stable mapping to
the configured account/key needs confirmation. The adapter does not guess that mapping or use the
field for authorization; local account scoping is not verification of this upstream identifier.

The authentication response is opaque. The current API reference says 30 minutes and the Express
guide says one hour; the earlier investigation also recorded a two-minute claim. Lifetime remains
UNVERIFIED. No expiry, cache, renewal, token decoding or tracker reuse assumption is implemented.

## Server configuration

Lazy loadSafepayConfig reads server variables only when explicitly invoked. Never prefix these with
NEXT_PUBLIC. No actual env file is changed or loaded by this implementation/testing workflow.

| Variable | Purpose |
|---|---|
| SAFEPAY_ENVIRONMENT | Explicit sandbox or production; no fallback/custom API host |
| SAFEPAY_MERCHANT_API_KEY | Merchant API key for the documented tracker request body |
| SAFEPAY_SECRET_KEY | Private merchant secret for X-SFPY-MERCHANT-SECRET |
| SAFEPAY_MERCHANT_ACCOUNT_REF | Stable internal account identity for local scoping; not a provider request field |
| SAFEPAY_ENTRY_MODE | Explicit flex/raw after merchant profile approval |
| SAFEPAY_SITE_ORIGIN | Trusted callback origin; HTTPS, except localhost HTTP in sandbox |
| SAFEPAY_RETURN_STATE_SECRET | Independent high-entropy local signing key, at least 32 printable ASCII characters |
| SAFEPAY_TIMEOUT_MS | Local HTTP deadline, 100–30000 ms; default 10000 |

API keys remain opaque: no undocumented key prefix is assumed. Configuration errors do not include
values. Credentials stay in closures and configuration JSON is redacted. HTTP errors never return
provider bodies, raw exceptions, private headers or authentication tokens.

The native fetch adapter disables redirects/cache/ambient credentials, bounds decoded JSON to 1 MiB,
limits the entire HTTP/body operation, and never retries POSTs automatically. Explicit engine/dependency
paths and a network-denial preload are used only in isolated testing; no SDK/dependency change is needed.

## Durable session workflow

createSafepayCheckoutService requires an injected store/provider/config and server-derived owner context.
createPrismaSafepayStore does not import/create the application DB client. It only operates on a pre-existing,
server-priced managed PENDING order with HELD inventory/coupon reservations and its active READY attempt.

1. Strictly validate orderId/paymentId/requestKey; no client amounts, owners, card details or URLs.
2. Derive owner binding from the trusted session user ID or an unpredictable guest cookie token.
   The browser request body must never supply that trusted context.
3. Verify owner, snapshots, PKR amount, active pointer, deadline, holds, coupon capacity and provider account.
4. Atomically claim Order/Payment versions, persist scoped request identity and append evidence BEFORE HTTP.
5. Create the tracker once. Validate its quote/context and durably bind its scoped tracker identity.
6. Recheck eligibility and claim authentication. Obtain one opaque token.
7. Prepare a fixed hosted destination with same-origin return/cancel URLs and signed local return state.
8. Recheck eligibility and durably mark CHECKOUT_ISSUED before exposing the redirect.

Order/payment settlement statuses, stock quantities, coupon counts and fulfilment are not changed.
A successful creation/redirect never means paid. No order or reservation allocator is implemented here.

Local identity hashes are versioned and scoped by owner/order/attempt or environment/account/tracker.
They are not provider idempotency keys. Merchant metadata is only correlation, not a duplicate-creation guarantee.

CREATING/crash/timeout/malformed/error responses remain non-retryable and require review. Even HTTP 4xx
is treated as uncertain for tracker creation: its side-effect semantics are not confirmed.
An existing tracker is not recreated after authentication failure or lost redirect response.
A different active attempt is also blocked if any earlier Safepay attempt has creation history, a tracker,
a verified reference or a potentially payable local phase. Changing a pointer does not cancel a tracker.
Replacement/reissue is intentionally blocked until provider finality and reuse/cancellation are confirmed.

Known unverified tracker observations are allowlisted in evidence. Failed persistence prevents redirection.
Claim records survive a provider-call/process crash; automatic lost-tracker recovery is not implemented
because the provider lookup/idempotency contract is unresolved. Reconciliation/administrative recovery
must be implemented before activation; this phase never clears an uncertain claim automatically.

## Redirect security

Authentication tokens and hosted URLs use private-field wrappers and redacted JSON. Call location() only
at an explicit no-store browser handoff, or use the prepared 303 response with no-referrer policy.
Do not log the URL/Location or cache it.

Return state uses a separate APPLICATION HMAC-SHA256 key, random nonce, bound order/attempt/owner and
a local deadline capped at 15 minutes and the reservation/access deadlines. This is NOT a Safepay webhook
signature and NOT a provider token lifetime. Verification also requires current server-derived owner context.

Return/cancel pages are not implemented yet. They must not trust query tracker/state as proof of payment,
change settlement status, or grant access based only on the signed state. Redirect replay remains read-only.

## Public endpoint and UI prerequisites

POST /api/checkout/safepay/session always returns SAFEPAY_INTEGRATION_BLOCKED with 503/no-store.
It does not import a DB client, load config, inspect merchant secrets or call the provider.
The existing COD/bank-transfer checkout routes/services/UI are unchanged. ONLINE still hits the existing guard.

Before connecting the customer UI:
- Complete support confirmations below and approve the actual merchant hosted profile.
- Rehearse PostgreSQL migration and role access on a verified disposable local instance, then separately
  authorize deployment. No actual application migration has been applied.
- Implement atomic pending order/attempt creation with existing server pricing, reservation-aware stock
  and coupon writers, expiration/release and an accepted-payment fulfilment guard across admin/customer paths.
- Resolve owner from NextAuth or a secure HttpOnly guest token; add bounded HTTP JSON parsing, same-origin/CSRF,
  rate limits and owner-authorized local status polling before activating the public route.
- Implement verified durable webhook ingestion/deduplication, evidence-based reconciliation, late success,
  safe cancellation/retry and refund handling. Preserve the offline paths.
- Add the fixed return/cancel pages and their no-store/no-referrer response policies.
- Only then review/remove the code activation gate and connect the UI. An admin/env toggle is insufficient.

## Direct Safepay support blockers

- Authoritative token lifetime/scope, renewal and multiple-token/tracker reuse semantics.
- Approved hosted entry mode/intent, PCI responsibility, automatic capture and capability behavior.
- Stable creation-response merchant identity/client mapping and its relationship to account/API keys.
- Exact webhook signed bytes/canonicalization, algorithm/encoding/header and signed fixtures; resolve the
  hosted-payment HMAC-SHA512 versus subscription examples without borrowing a subscription algorithm.
- Stable merchant/environment event identity, duplicate body variation, event ordering, retries and replay.
- Supported status endpoint/version and fields proving capture, pending/failed finality and cumulative refunds.
- Provider creation idempotency/concurrency/retention, error side-effect guarantees and lost-response lookup.
- Tracker cancellation/expiration/in-flight late capture and when a replacement is provably safe.
- Partial/full refunds, partial captures and handling an expired reservation after financial success.

## Tests

Mocked provider tests exercise confirmed payloads, origins, validation, redaction, HTTP/JSON/timeout failures,
response mismatches, local signed-state verification and disabled-route behavior.
Disposable SQLite integration tests exercise real durable claims/evidence/versions, successful preparation,
authentication failure, concurrency/replay, crashed/uncertain/replacement attempts, ownership, snapshot/hold
validation, expiry during HTTP and persistence failure. No real provider request is required or permitted.

The test-only server-only alias substitutes Next.js's poison marker only inside Vitest.
The default disposable DB harness includes integration.safepay.test.ts. Generate both clients in an isolated
copy before running all unit/database suites; do not regenerate existing application clients for this phase.

Verification on 2026-11-05: 217/217 tests passed across 14 files (142 existing, 52 provider/configuration/
redirect tests, 23 durable-session integration tests). Both clients generated in the isolated workspace;
TypeScript and scoped ESLint passed. HTTP was mocked and JavaScript network access was denied.
Only fresh, marked disposable SQLite test databases were initialized; no migration was applied and no
production/Supabase/Safepay API was contacted. PostgreSQL execution and role checks remain unverified.

