# Safepay server integration — sandbox verification phase

Status: sandbox hosted sessions, browser return, authenticated evidence adapters, the
webhook endpoint and the manual maintenance trigger are implemented. Production remains
code-gated (lib/safepay/readiness.ts). No migration rehearsal, live provider call or
production activation is part of this phase.

## Verified provider contract (2026-11-09 correction)

The following points are confirmed against the official Safepay card-payment documentation
(site: safepay-docs.netlify.app, source: github.com/getsafepay/safepay-docs — the hosted-
checkout generation this merchant uses) and are implemented in
src/lib/safepay/verification.ts and src/app/api/webhooks/safepay/route.ts. The newer
Raastwire documentation generation (safepay.mintlify.app: HMAC-SHA256 over
"timestamp.body", five X-SFPY-* headers, aggregator envelopes) is a different product
surface and is deliberately NOT implemented.

- Post-payment redirect: the hosted checkout appends the tracker to the redirect URL
  ("Get the `tracker` that is appended to the return URL"). Because the documented
  example redirect_url is query-free and Safepay appends with a bare `?`, a return URL
  that already carries `?state=` folds the tracker into the state value
  (`?state=S?tracker=T`). The return flow therefore no longer depends on provider query
  merging: the signed state also travels in an HttpOnly first-party cookie
  (`khd_sfpay_return`, 15 min), and the tracker is accepted from the query param, from
  the folded form, or from the locally stored tracker binding as a last resort.
- Webhook authenticity (official page "Verify HMAC signatures"): `X-SFPY-SIGNATURE`,
  HMAC-SHA512 over the raw request body bytes, hex digest, keyed by the dashboard
  "Developers > Endpoints" shared secret. The official page shows exactly
  `crypto.createHmac("sha512", secret).update(data).digest("hex")`. This generation
  documents NO signed delivery-timestamp header; timestamp freshness is therefore
  deliberately NOT enforced — the documented retry model redelivers queued events (old
  `created_at`) and no tolerance is documented, so a freshness gate would reject
  legitimate redeliveries. Replay resistance comes from the signature plus durable
  event-id dedup in the inbox. The docs' rotation note (queued events stay signed with
  the previous key) is a merchant ops consideration at activation.
- Webhook envelope (official page "Webhook structure and types"): `{type, version,
  token, merchant_api_key, endpoint, data, created_at, delivery_attempts,
  next_attempt_at}` with `{seconds, nanos}` timestamps. Only `type` and `data` are
  treated as mandatory; the other fields are validated whenever present
  (`version` must be the documented "2.0.0" generation; a foreign `merchant_api_key` is
  rejected; malformed timestamps reject the event). The documented event `token`
  (evt_…) is the primary event identity used for dedup; the X-SFPY-EVENT-ID header and
  the body hash are fallbacks.
- Webhook event data (official page "Webhook structure and types"): `data.tracker` is a
  tracker-token STRING with `state`, `amount` and `currency` as SIBLING fields.
  `payment.succeeded` ("fired when a payment is captured") documents `data: {tracker,
  intent, state: "TRACKER_ENDED", net, fee, customer_email, amount, currency: "PKR",
  metadata, charged_at}` — amount is PKR minor units (paisa). `payment.failed` ("fired
  when an error occurs during the payment process") documents `data: {tracker, intent,
  state, customer_email, metadata, category, code, message, failed_at}` — NO amount or
  currency fields; the official example state is `TRACKER_ENROLLED` (pre-authorization).
  The undocumented tracker-OBJECT webhook shape (previously accepted) is no longer
  parsed: that form exists only in the Fetch Tracker response.
- Financial validation: for payment.succeeded the provider-reported amount and currency
  are mandatory and must be a safe positive integer in PKR equal to the locally
  expected attempt amount; missing, invalid or contradictory financial information is
  REJECTED into the review quarantine. The locally expected amount is never substituted
  for a missing provider-reported amount. payment.failed records no amounts (all money
  fields null) because the documented shape carries none.
- Tracker state vocabulary (official page "Tracker states"): TRACKER_STARTED,
  TRACKER_AUTHORIZED, TRACKER_ENROLLED, TRACKER_ENDED ("The tracker has been paid."),
  TRACKER_CANCELLED, TRACKER_EXPIRED, TRACKER_REFUNDED, TRACKER_PARTIAL_REFUND,
  TRACKER_DISPUTED, TRACKER_REVERSED, TRACKER_VOIDED. TRACKER_ENDED is the ONLY
  documented paid state and NO state is documented as payment-failure finality. The
  docs explicitly instruct servers to accept event types and state values beyond the
  documented list, so unknown states never reject — they classify non-final.
- Webhook classification matrix (conservative):
  - payment.succeeded + TRACKER_ENDED + valid matching PKR amount → CAPTURE_CONFIRMED
    (captured amount = provider amount, occurredAt = signed charged_at).
  - payment.succeeded + any other/missing/unknown state → REVIEW_REQUIRED (never
    capture). This closes the previous hole where a missing state still settled.
  - payment.failed + TRACKER_ENDED → REVIEW_REQUIRED (contradiction with capture).
  - payment.failed + anything else (missing/TRACKER_STARTED/TRACKER_ENROLLED/unknown)
    → UNCERTAIN (non-final). A failed webhook NEVER becomes FAILURE_CONFIRMED because
    the documented vocabulary defines no failure-final state — see support blockers.
    Uncertain/failure observations never release inventory or coupon reservations:
    reservation release happens only through the existing expiry lifecycle.
  - Any other event type (payment.refunded, authorization.*, void.*, subscription.*) →
    quarantined with the original encrypted bytes for manual review; no automated
    refund processing exists.
- Status lookup (official page "Fetch Tracker"): GET /reporter/api/v1/payments/{tracker};
  the documented response is `{ok: true, data: {token, environment, state, intent,
  mode, entry_mode, …, purchase_totals: {quote_amount: {currency, amount}, …}}}` — the
  tracker fields sit DIRECTLY under `data`. The previous implementation expected an
  undocumented `data.tracker{…}` wrapper plus `status.errors` and would have rejected
  the documented response shape; it now parses the documented shape (ok must be true
  when present; environment/PKR/amount-vs-expected all validated; state classified with
  the same vocabulary: TRACKER_ENDED → CAPTURE_CONFIRMED, documented in-progress states
  (TRACKER_STARTED/AUTHORIZED/ENROLLED) → PENDING, everything else → UNCERTAIN).
  X-SFPY-MERCHANT-SECRET is still sent; note the docs' example curl carries no auth
  header — live confirmation of reporter authentication is an activation blocker.
- Delivery semantics: acknowledge 2xx within the 10-second window after durable
  storage; 4xx is terminal, 5xx/503 re-enters the provider retry queue. Inbox
  processing runs out of band, never inside the delivery window.

## Earlier verification notes (2026-11-08)

The following points were confirmed against official Safepay documentation and are now
implemented (src/lib/safepay/verification.ts, src/app/api/webhooks/safepay/route.ts):

- Post-payment redirect: the hosted checkout appends the tracker to the redirect URL
  ("Get the `tracker` that is appended to the return URL"). Because the documented
  example redirect_url is query-free and Safepay appends with a bare `?`, a return URL
  that already carries `?state=` folds the tracker into the state value
  (`?state=S?tracker=T`). The return flow therefore no longer depends on provider query
  merging: the signed state also travels in an HttpOnly first-party cookie
  (`khd_sfpay_return`, 15 min), and the tracker is accepted from the query param, from
  the folded form, or from the locally stored tracker binding as a last resort.
- Webhook authenticity: `X-SFPY-SIGNATURE`, HMAC-SHA512 over the raw request body bytes,
  hex digest, keyed by the dashboard "Developers > Endpoints" shared secret. A newer
  platform generation documents HMAC-SHA256 over `timestamp.body` with five X-SFPY-*
  headers; that contract is deliberately NOT accepted here — unrecognized events or
  signature profiles are quarantined for review, never processed.
- Webhook events: JSON envelope `type` ("payment.succeeded"/"payment.failed") plus a
  `data` payment object; tracker facts are parsed only from the documented
  `data.tracker` token string with sibling `state`/`amount`/`currency`. Any other type
  or shape is quarantined with the original encrypted bytes.
- Success finality: only tracker state `TRACKER_ENDED` classifies as CAPTURE_CONFIRMED.
  `TRACKER_STARTED` is PENDING; every other state stays UNCERTAIN or REVIEW_REQUIRED.
  No failure/expiration state is guessed.
- Status lookup: GET /reporter/api/v1/payments/{tracker} with X-SFPY-MERCHANT-SECRET,
  used by the reconciliation channel (admin maintenance trigger) for independent
  server-side verification.
- Delivery semantics: acknowledge 2xx within the 10-second window after durable
  storage; 4xx is terminal, 5xx/503 re-enters the provider retry queue. Inbox
  processing runs out of band, never inside the delivery window.

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

Return/cancel pages are read-only. They never treat query tracker/state as proof of
payment, never change settlement status, and grant access only after the signed state
(or the tracker echo plus the server-derived session owner) re-validates the managed
attempt in the database. Redirect replay remains read-only.

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
- RESOLVED 2026-11-09 from official docs (developers/webhooks/*): webhook signed bytes are the raw
  request body, HMAC-SHA512/hex in X-SFPY-SIGNATURE; envelope/event shapes and the tracker-state
  vocabulary are documented and implemented. Still open: one authorized sandbox transaction with the
  merchant's real endpoint secret to confirm live deliveries match the documented shapes byte-for-byte.
- RESOLVED 2026-11-09: event identity (envelope `token`), redelivery/retry fields (delivery_attempts,
  next_attempt_at) and duplicate handling are documented and idempotent in the inbox.
- No documented tracker state establishes payment-FAILURE finality (TRACKER_CANCELLED/EXPIRED are
  terminal-but-not-failure). Until Safepay documents one, payment.failed webhooks stay non-final
  (UNCERTAIN/REVIEW_REQUIRED) and FAILURE_CONFIRMED is never derived from provider evidence.
- Whether the Fetch Tracker endpoint actually requires X-SFPY-MERCHANT-SECRET: the official example
  curl shows no auth header. Confirm live before activation; the secret stays sent meanwhile.
- Supported status endpoint/version and fields proving capture, pending/failed finality and cumulative refunds.
- Provider creation idempotency/concurrency/retention, error side-effect guarantees and lost-response lookup.
- Tracker cancellation/expiration/in-flight late capture and when a replacement is provably safe.
- Partial/full refunds, partial captures and handling an expired reservation after financial success.
  Refund/authorization/void events are quarantined for manual review; no automated refund handling exists.

## Tests

Mocked provider tests exercise confirmed payloads, origins, validation, redaction, HTTP/JSON/timeout failures,
response mismatches, local signed-state verification and disabled-route behavior.
Disposable SQLite integration tests exercise real durable claims/evidence/versions, successful preparation,
authentication failure, concurrency/replay, crashed/uncertain/replacement attempts, ownership, snapshot/hold
validation, expiry during HTTP and persistence failure. No real provider request is required or permitted.

Webhook-contract tests (tests/unit/safepay-verification.test.ts, 2026-11-09) use the documented payload
shapes only: string `data.tracker` with sibling `state`/`amount`/`currency`; documented payment.failed
payload (TRACKER_ENROLLED, no financial fields) classifying UNCERTAIN with null amounts; missing/unknown
states never capturing or failing; contradictory evidence routed to review; missing/contradictory amounts
rejected instead of substituted; foreign merchant_api_key/environment rejected; tracker-object webhooks and
non-2.0.0 generations rejected; malformed timestamps rejected and absent ones tolerated; old-but-signed
redeliveries classified normally (no invented freshness rule); documented Fetch Tracker response shape with
amount-vs-expected validation. Integration coverage (integration.safepay-webhook.test.ts) adds: documented
failure observation stored → recorded with reservations HELD and a scheduled re-check; contradictory
failure evidence → review_required with holds retained; capture evidence with a wrong amount → quarantined;
signature tampering → quarantined; redelivery idempotency; and the settled-order happy path.

The test-only server-only alias substitutes Next.js's poison marker only inside Vitest.
The default disposable DB harness includes integration.safepay.test.ts. Generate both clients in an isolated
copy before running all unit/database suites; do not regenerate existing application clients for this phase.

Verification on 2026-11-05: 217/217 tests passed across 14 files (142 existing, 52 provider/configuration/
redirect tests, 23 durable-session integration tests). Both clients generated in the isolated workspace;
TypeScript and scoped ESLint passed. HTTP was mocked and JavaScript network access was denied.
Only fresh, marked disposable SQLite test databases were initialized; no migration was applied and no
production/Supabase/Safepay API was contacted. PostgreSQL execution and role checks remain unverified.


## Verification loop completion (2026-11-09 update)

Audit finding: settlement evidence previously had only two entry points — Safepay webhooks
(impossible on origins Safepay cannot reach, e.g. localhost/preview) and the admin maintenance
sweep (never scheduled). A customer who paid at the hosted checkout and returned to the store
stayed PENDING forever; the admin fulfilment gate correctly answered 409. Three connected
additions close that gap without weakening any check:

1. **Targeted verification** (`src/services/payment-verification.service.ts`): ONE server-initiated
   reporter lookup (`GET /reporter/api/v1/payments/{tracker}`, merchant secret) for a single
   payment whose id was resolved from a trusted, owner-validated context. The tracker token always
   comes from the database; the exact response bytes flow through the approved reconciliation
   adapter → inbox → settlement pipeline (identity, amounts, currency, environment and reservation
   integrity are re-validated inside the settlement transaction). Transport failures only schedule
   capped exponential retry backoff (60s → 15min) on scheduling fields — financial state is never
   touched and no failure is ever invented from a timeout.
2. **Return-page trigger**: the read-only return page still never trusts the browser redirect, but
   a PENDING snapshot now triggers exactly one targeted verification for that owner's payment and
   re-reads the snapshot, so a successful sandbox payment shows "Payment verified" on return.
3. **Scheduled maintenance worker** (`src/instrumentation.ts` → `payment-maintenance-worker.service.ts`):
   the same bounded, idempotent actions as the admin maintenance endpoint (reservation expiry,
   webhook-inbox processing, reconciliation sweep) run every ~60s in-process, single-flight,
   unref'd timer, batches 10/10/5. Opt out with `PAYMENT_MAINTENANCE_WORKER=off` (serverless
   deploys should schedule `POST /api/admin/payments/maintenance` externally instead).
   The admin endpoint gained a scoped `verify_order_payment` action (admin session mandatory,
   optional `x-khd-maintenance-token`, rate-limited) — a re-check, never a manual status override.
4. **Admin diagnostics** (read-only): the admin order detail page shows the managed payment's
   attempt/reconciliation/verification state, review reason, reservation and coupon states, inbox
   event processing states and recent evidence — no tracker tokens, no signatures, no payload
   bytes, no secrets — plus the guarded "Re-check payment with Safepay" action.

`loadSafepayApiOnlyConfig` derives an API-only config (non-routable placeholder origin) for
background sweeps; the reconciliation channel never builds customer-facing URLs. New tests:
`tests/unit/payment-verification.test.ts`, `tests/unit/payment-maintenance-worker.test.ts`,
rewritten `tests/unit/admin-payments-maintenance.test.ts` (route semantics against the shared
runner) and `tests/unit/integration.safepay-return-verify.test.ts` (real disposable persistence:
pending → targeted verify → settled → reservations consumed → coupon committed → the previously
409 fulfilment gate allows processing; replay is a no-op; pending provider states stay pending with
one scheduled retry; transport failures schedule capped backoff without inventing finality).
