# Checkout lifecycle — COD + Safepay

The full order lifecycle as implemented after Phase 3, chunk 3-final
(branch `phase3/complete-ecommerce`). This document is factual to the
code; where a behaviour depends on a provider answer that has not
arrived, it says so instead of inventing one.

## Principles

- **Login required.** Checkout and order tracking require a signed-in
  customer; there is no guest checkout. Every checkout entry point
  resolves the customer from the session (`getSessionUser`), never from
  client-supplied identity.
- **Server-side pricing only.** The client never supplies prices,
  totals, discounts, or delivery fees. The quote and the reservation
  are priced from database rows inside a transaction
  (`src/services/checkout.service.ts`, `src/services/safepay-pending-order.service.ts`).
- **Payments are COD and Safepay only.** Bank transfer is disabled.
  Production Safepay payments stay disabled; the sandbox is the only
  live Safepay environment.
- **Money moves only on verified evidence.** Settlement, refunds, and
  review resolution act on authenticated provider evidence (webhook or
  the documented reporter endpoint), never on a browser claim.

## 1. Cart → quote → reservation

1. **Cart.** A signed-in customer has one cart (`Cart`, one row per
   user). Items carry a product, an optional variant, quantity, and
   gift-wrap. The cart has a `version` column (Phase 3, chunk 3-final):
   the pending-order service claims it version-gated
   (`updateMany` with `version` in the `where` clause) before reading
   the cart, so two concurrent checkouts for the same cart cannot both
   reserve the same lines. The loser gets `BUSY` (409); the winner
   proceeds. There is deliberately **no persistent cart lock** while a
   payment is in flight: once the pending order is created, the
   purchased lines are deleted from the cart in the same transaction
   and the pending order is a frozen snapshot, so no cart mutation can
   desync it. A 15-minute lock would be a UX regression with no safety
   benefit. Cart edits do not bump the version; the `deleteMany`
   exact-snapshot guard at the end of pending-order creation still
   catches a cart that changed mid-transaction.
2. **Quote.** `POST /api/checkout/quote` (`quoteOrder`) returns the
   server-priced subtotal, discount, delivery fee, and total, plus any
   automatic promotion or coupon that applies. A quote never reserves
   anything.
3. **Reservation (managed pending order).** Placing an order creates a
   `PENDING` order (`paymentFlowVersion: 1`) with a `PENDING` payment
   attempt, and holds the stock and any coupon in the same transaction:
   - `InventoryReservation` rows go to `HELD` and the sellable
     `Inventory.quantity` is decremented.
   - A `CouponReservation` goes to `HELD` (`reservedCount` +1);
     `usedCount` does not move until the order is paid.
   - The order records `reservationExpiresAt` =
     now + **15 minutes** (`RESERVATION_TTL_MS` in
     `src/app/api/checkout/safepay/session/route.ts`).
   - The order is the customer's: `checkoutOwnerKind` /
     `checkoutOwnerHash` bind it to the session owner, and
     `paymentOwnerOrderId` / `activePaymentId` point at the order and
     its current payment attempt.
   - A client idempotency key replays the same reservation instead of
     creating a second one; a changed input with the same key is
     rejected (`REQUEST_CONFLICT`).

## 2. COD path

`placeOrder` with `paymentMethod: "COD"` creates the order as
**`CONFIRMED`** with `paymentStatus: "PENDING"` (D3 — COD is confirmed
on placement, not pending). The inventory and coupon holds are consumed
at placement: the reservation becomes the order. A COD order below
Rs 1 after discounts and delivery is rejected server-side
(`MINIMUM_NOT_MET`, 422). COD orders are paid on delivery; there is no
online capture to verify.

## 3. Safepay path

### 3.1 Tracker creation and the local idempotency guard (H-3)

The Safepay docs do **not** document a provider-side idempotency key
for `POST /order/payments/v3/` (see
`docs/SAFEPAY-SERVER-INTEGRATION.md:262-270`), so the guard is local:

- The attempt store (`src/services/safepay-attempt.store.ts`) owns a
  durable claim per payment attempt: `claim()` moves a `READY`
  payment to `CREATING` and records the request identity hash
  (`retryRequestKey`). A second concurrent creation for the same
  payment is blocked — `CREATION_UNCERTAIN` for the same request,
  `REQUEST_CONFLICT` for a different request key — and no second
  `createTracker` call is ever dispatched.
- The tracker is bound to the payment row (`bindTracker`) **before**
  the hosted redirect is issued, so a crash after creation never loses
  it.
- **Resume.** A bound-but-never-issued tracker for the *same* request
  is resumed, not recreated (`store.resume()` in
  `src/services/safepay-checkout.service.ts`): `TRACKER_CREATED`
  retries the metadata attach and continues; `AUTHENTICATING` skips
  straight to authentication. Resume is refused for `CREATING` /
  `CREATION_UNCERTAIN` (the creation outcome is unknown — a tracker
  may exist at the provider that we cannot see), for
  `CHECKOUT_ISSUED` (a redirect may already be live), for a different
  request key, and for a replacement attempt while an older attempt
  may still be payable. The checkout session route maps a refused
  resume to 409.
- Attempt states: `READY` → `CREATING` → `TRACKER_CREATED` →
  `AUTHENTICATING` → `CHECKOUT_ISSUED` → `SETTLED` / `CLOSED`, with
  `CREATION_UNCERTAIN` for an ambiguous creation (network error,
  timeout, HTTP error, tracker mismatch, metadata failure, or a bind
  failure). An uncertain attempt is never retried automatically; it is
  `REVIEW_REQUIRED` and the admin review queue owns it.

### 3.2 Hosted checkout and return

The customer is redirected to the Safepay hosted checkout with a
signed local return state (`signReturnState`, 15-minute bound). On
return, `src/app/(store)/checkout/safepay/return/page.tsx`:

1. Verifies the signed state for the session owner (a failed HMAC or
   expiry never widens the lookup; the provider tracker echo is used
   only when the provider actually supplied one).
2. Runs one targeted verification (`verifyPaymentNow`) against the
   documented reporter endpoint
   (`GET /reporter/api/v1/payments/{tracker}`), feeding the exact
   provider bytes through the authenticated reconciliation channel.
3. On a `TRACKER_ENDED` capture: settlement consumes the holds, marks
   the payment `PAID`, the order `CONFIRMED` / `paymentStatus: PAID`,
   commits the coupon (`usedCount` +1, `reservedCount` −1), and records
   the order status history. On any other provider state the payment
   stays `PENDING` and a retry is scheduled with capped exponential
   backoff (60s → 15min).

### 3.3 Payment not completed (honest flow)

There is **no Safepay decline signal** in the documented API, and none
is invented (H-1, D5 pending — the support inquiry is drafted, not
sent). A payment that is not verified as captured stays `PENDING` with
the reservation held until it expires or is cancelled; the customer
sees "payment not completed" and the order is held for admin review.
The order is never marked failed on speculation.

### 3.4 Cancel (H-2)

Cancelling at the hosted checkout returns the customer to
`/checkout/safepay/cancel`, which now actually releases the
reservation (`src/services/safepay-cancel.service.ts`,
`resolveSafepayCancel`). The flow resolves the returning customer to
their own managed order (signed state first, tracker echo as fallback)
and closes it through the existing owner-bound reservation service.
**Local release only** — no provider reversal is called, because none
is confirmed (D6 pending) and none is needed: nothing was captured on
a cancelled checkout.

Outcomes, rendered truthfully on the page:

| Outcome | Meaning |
|---|---|
| `released` | No tracker existed; the reservation is released, stock and coupon restored, order `CANCELLED` with payment `CANCELLED`. No money moved. |
| `review_required` | A tracker existed, so the payment may have been captured. The order closes but the holds stay `HELD` for admin review (`paymentReviewStatus: REQUIRED`). |
| `already_closed` | The reservation was already closed — a refresh or double visit never double-releases. |
| `close_failed` | The close could not be completed safely; the reservation expires automatically and the customer is told so. |
| `invalid` | The return could not be verified as the customer's (bad/expired state, wrong owner, no tracker). Nothing is touched. |

### 3.5 Expiry and the pre-expiry provider check (M-26)

The maintenance worker runs every 60 seconds. Each sweep runs, in
order: `verify_expiring_payments`, `expire_reservations`,
`process_webhook_inbox`, `reconcile_due_payments`,
`reconcile_refunds`, `cleanup_email_outbox`, `prune_stale_carts`.

- **Pre-expiry check.** `verify_expiring_payments` lists managed
  payments whose reservation expires within the next **5 minutes**
  (`dueForPreExpiryCheck`) and force-verifies each one
  (`verifyPaymentNow(id, { force: true })`). Force bypasses the
  transport-failure backoff (which can grow to 15 minutes — longer
  than the reservation itself) but never doubles a fetch already in
  flight. This is the last chance to settle a capture while settlement
  is still possible: once the reservation has expired, settlement can
  only ever `LATE_CAPTURE`-review.
- **Expiry.** `expireBatch` closes expired `PENDING` reservations.
  Before closing a tracker-bearing candidate it consults the provider
  once through the injected verifier (`checkBeforeExpiry`):
  a settled payment is never expired (outcome `SETTLED`); a recorded
  or review outcome means the evidence is on file and the close
  proceeds with holds retained for review; a failed or skipped consult
  closes as before — the close retains holds for review and the
  `investigate_closed_order_payment` action consults the provider
  later. Deferring instead would strand the order: a deferred order
  stays `PENDING` with an expired reservation, invisible to the review
  queue and unresolvable until it is closed. A never-started attempt
  (no tracker) is released with stock and coupon restored.

## 4. Cancellation

- **Customer cancel (D1).** `POST /api/account/orders/[id]/cancel`
  allows `PENDING` / `CONFIRMED` / `PROCESSING` orders only, with an
  optional reason (≤ 500 chars). Ownership is enforced (a non-owner
  gets 404), the close is atomic (inventory and coupon restored in the
  same transaction), and a double cancel is idempotent.
- **Paid Safepay cancel (H-12).** Cancelling a paid order restocks and
  frees the coupon, but does **not** refund: the payment stays `PAID`
  and the refund is left to the manual flow (D6 pending — no reversal
  API confirmed). Partially or fully refunded paid orders cannot
  cancel through this path; they need manual handling.
- **Admin cancel.** Admins close orders through the same
  `closeManagedPendingOrder` machinery, with the action audit-logged.
- Every status change is recorded in `OrderStatusHistory` (dated,
  with optional carrier/tracking on `SHIPPED`); snapshots and the
  admin audit log are untouched by the close.

## 5. Refunds

Refunds use the documented endpoint
`POST /order/payments/v3/{tracker}/refund` (see
`docs/SAFEPAY-REFUND-SANDBOX-VERIFICATION.md` §0–§9). The local rules:

- **24-hour reversal window (M-27).** A capture less than 24 hours
  old may need a *reversal*, not an ordinary refund, and no reversal
  endpoint is documented — so an in-window refund request is parked
  in `REVIEW_REQUIRED` (`REFUND_WINDOW_REVERSAL_24H`) and **never
  submitted to the provider**. A repeated identical in-window request
  returns the existing parked row instead of queueing a duplicate
  (dedup on payment + reason + amount; the idempotency-key replay
  covers the keyed path).
- **Post-window release.** The `reconcile_refunds` sweep releases due
  parked rows first (`releaseDueWindowRefunds`): each row is claimed
  version-gated (`REVIEW_REQUIRED` → `REQUESTED`) after re-validating
  the refundable guard and the remaining balance, so a row is released
  exactly once and never submitted twice. The normal submit path then
  submits it through the documented endpoint. Rows whose payment is no
  longer refundable, whose capture is still inside the window, or
  whose amount no longer fits stay parked for manual review.
- **90-day card window.** Past 90 days the local payment method is
  unknown, so the request is parked (`REFUND_WINDOW_METHOD_UNVERIFIED`)
  instead of being applied blindly.
- **Exactly-once submission.** A `REQUESTED` row is claimed
  (`REQUESTED` → `SUBMITTING`) before the provider call, so a crash
  can never lose the fact that a submission may have happened.
  `SUBMITTING` rows are never automatically resubmitted; their outcome
  is resolved by reconciliation against the reporter endpoint.
  `payment.refunded` is **not** subscribed on the webhook, so refunds
  finalise through reconciliation, not webhooks.
- **Balances.** Only verified paid orders count as revenue; paid and
  pending amounts are reported separately.

## 6. What is deliberately not here

- **H-1 / D5 — decline finality.** No decline signal is documented
  and none is invented. Awaiting the Safepay support answer.
- **D6 — reversal API.** No reversal endpoint is confirmed for classic
  checkout, and no speculative reversal/void/refund provider call is
  made. Refunds inside 24 hours stay manual/queued; if Safepay
  confirms a reversal API, the queue is the place to call it.
- **Provider idempotency key.** Not documented for tracker creation;
  the local claim + resume is the guard.
- **Session revocation / recovery-code redesign / shared rate-limit
  store.** Deferred from Phase 2 finalization; unchanged by this
  chunk.

## 7. Files

| Area | Files |
|---|---|
| Pending order + cart claim | `src/services/safepay-pending-order.service.ts` |
| Attempt store (claim/resume/bind/advance) | `src/services/safepay-attempt.store.ts` |
| Checkout session | `src/services/safepay-checkout.service.ts`, `src/app/api/checkout/safepay/session/route.ts` |
| Reservation close / expire | `src/services/safepay-reservations.service.ts` |
| Cancel return | `src/services/safepay-cancel.service.ts`, `src/app/(store)/checkout/safepay/cancel/page.tsx` |
| Return + verification | `src/app/(store)/checkout/safepay/return/page.tsx`, `src/services/payment-verification.service.ts`, `src/services/payment-reconciliation.service.ts` |
| Settlement / review | `src/services/payment-settlement.service.ts`, `src/services/payment-review.service.ts` |
| Refunds | `src/services/payment-refund.service.ts` |
| Maintenance | `src/services/payment-maintenance.service.ts`, `src/services/payment-maintenance-worker.service.ts` |
| Provider | `src/lib/safepay/provider.ts`, `src/lib/safepay/redirect.ts`, `src/lib/safepay/return-input.ts` |
| Safepay docs | `docs/SAFEPAY-SERVER-INTEGRATION.md`, `docs/SAFEPAY-REFUND-SANDBOX-VERIFICATION.md`, `docs/SAFEPAY-RESERVATIONS.md`, `docs/PAYMENT-SETTLEMENT.md` |
