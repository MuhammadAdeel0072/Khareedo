# Safepay Refund — Sandbox Verification Procedure

Scope: manual, operator-run verification of the refund lifecycle against the real Safepay
sandbox, using the credentials already configured in the deployment environment. **No
secrets are ever pasted into chat, logs, or this repository.** Production remains
code-gated off (`SAFEPAY_REFUNDS_SANDBOX_ONLY`, `SAFEPAY_SERVER_ACTIVATION.enabled=false`).

Precondition truth: every automated test in this repo is mock-based. Passing them does
NOT prove real Safepay sandbox behavior. The steps below are the only way to convert
"implemented and mock-tested" into "verified against the provider".

## 0. Preconditions

1. Sandbox env configured (`SAFEPAY_ENVIRONMENT=sandbox`, real merchant key/secret in env,
   `SAFEPAY_WEBHOOK_SECRET` set, `PAYMENT_PAYLOAD_KEY`/`PAYMENT_PAYLOAD_KEY_ID` set).
2. Admin account exists (role ADMIN) with a working session.
3. Safepay dashboard: a webhook endpoint is registered (or note 6a below if not possible).
4. PostgreSQL migrations deployed through `20261110000000_safepay_refund_ledger`
   (rehearse on a staging DB first; the migration is additive but untested live).
5. Record every HTTP exchange (status + sanitized body) in the worklog.

## 1. Complete a sandbox payment

- Buy any product via hosted checkout with a sandbox instrument.
- Verify locally: `Payment.status=PAID`, `capturedAmountMinor=expectedAmountMinor`,
  `order.paymentStatus=PAID`, reservations CONSUMED, evidence row recorded.

## 2. Full refund via admin API

```
POST /api/admin/payments/refunds        { "paymentId": "<id>" }          # omitted amount = full
```

- [ ] 201; response `result.kind="created"`, `submission.kind="submitted"`.
- [ ] Provider response recorded; note the returned tracker state verbatim.
      **Open question Q1: does the sandbox refund response carry `data.tracker.state`, and
      is it `TRACKER_REFUNDED` synchronously?**
- [ ] Refund row: status PENDING (NOT SUCCEEDED — accounting awaits verified evidence).
- [ ] `Payment.refundedAmountMinor` still NULL before the webhook (correct: 2xx ≠ evidence).

## 3. Refund webhook

- [ ] `payment.refunded` delivery received at `/api/webhooks/safepay` → 200 `stored`.
      **Q2: exact payload nesting of `refund_amount` / `balance` / `refunded_at`
      (siblings of `tracker` under `data`? does `tracker` include `purchase_totals`?).**
      If nesting differs from the adapter's extraction, the event is quarantined — export
      the encrypted payload via the review flow and adjust the adapter, never the verifier.
- [ ] Inbox process → `{ kind: "settled" }`; refund row SUCCEEDED with `confirmedAt`;
      `Payment.status=REFUNDED`, `refundedAmountMinor=capturedAmountMinor`;
      `order.paymentStatus=REFUNDED`; evidence row with `refundId` linked.
- [ ] Redeliver the same webhook (Safepay dashboard "resend" if available) → `duplicate`,
      no second ledger effect.

## 4. Partial refunds

- [ ] Partial refund (e.g. half the balance): `type=PARTIAL`, payment stays `PAID` with
      advanced `refundedAmountMinor`, order stays `PAID`.
- [ ] Second partial completing the balance → payment `REFUNDED`.
- [ ] Over-refund attempt (amountMinor > remaining) → 409 `REFUND_EXCEEDS_REMAINING`.
      **Q3: does the provider also reject cumulative over-refund, and with which code?**

## 5. Reconciliation and recovery

- [ ] Simulate missing webhook: refund a payment, then run
      `POST /api/admin/payments/maintenance { "action": "reconcile_refunds" }` until the
      reporter poll finalizes the PENDING row (max 6 attempts by default).
      **Q4: does `GET /reporter/api/v1/payments/{tracker}` report
      `TRACKER_REFUNDED`/`TRACKER_PARTIAL_REFUND` after refunds?**
- [ ] Simulate provider timeout: point `SAFEPAY_TIMEOUT_MS=100` temporarily (or block
      network) → submission uncertain (`lastSubmissionCode=TIMEOUT`, row PENDING, no
      retry), then restore and reconcile → settled. Assert the provider processed exactly
      ONE refund (check the dashboard).
- [ ] Stale SUBMITTING (kill the server between claim and provider response if possible)
      → sweep parks it REVIEW_REQUIRED `SUBMIT_OUTCOME_UNKNOWN`; never resubmitted.

## 6. External dashboard refund

- [ ] Refund fully/partially from the Safepay dashboard for a locally PAID payment.
- [ ] With webhook delivery active: a `payment.refunded` event arrives with no local open
      row → PROVIDER-initiated SUCCEEDED row + accounting.
      **Q5: does the dashboard refund actually emit `payment.refunded` to our endpoint?**
- [ ] Without webhook delivery: run `reconcile_refunds`... note that with no open local row
      and no webhook, the reporter poll for a paid payment produces no refund observation
      unless the tracker state changed. Verify what the reporter shows. If the dashboard
      refund is invisible to both channels, it is a documented detection gap: reconcile
      manually and record it in the worklog (this is the residual risk of Q5/Q4).

## 7. Reversal handling

- [ ] If the sandbox permits voiding an authorization (dashboard), trigger `void.succeeded`
      or `authorization.reversed` for a local tracker → quarantined/REVERSAL_NOTICE →
      payment review REQUIRED, no accounting change. **Q6: are these events reachable in
      sandbox for `mode=payment` trackers at all?**

## 8. Windows

- [ ] Refund within 24h of capture → parked REVIEW_REQUIRED `REFUND_WINDOW_REVERSAL_24H`
      (no provider call). Confirm with Safepay whether a reversal API exists for classic
      checkout (**Q7**); until then this is manual handling.
- [ ] A capture older than 90 days (synthetic row) → parked
      `REFUND_WINDOW_METHOD_UNVERIFIED`; confirm method-level support (**Q8**).

## 9. Report-back

Fill the worklog with: what was verified, what could not be simulated and why, verbatim
provider states/codes observed, and any adapter adjustment made in response to real
payload shapes (with tests updated to the observed contract, not guesses).
