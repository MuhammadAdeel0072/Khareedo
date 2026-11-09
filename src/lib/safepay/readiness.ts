import "server-only";

// Deliberate code gate. No environment variable or admin setting can activate this phase.
export const SAFEPAY_SERVER_ACTIVATION = Object.freeze({
  enabled: false as const,
  blockers: Object.freeze([
    "MERCHANT_HOSTED_ENTRY_MODE_AND_PCI_APPROVAL",
    "MERCHANT_RESPONSE_ACCOUNT_IDENTITY_MAPPING",
    "AUTHENTICATION_TOKEN_LIFETIME_AND_TRACKER_REUSE",
    "WEBHOOK_SIGNED_BYTES_EVENT_ID_AND_RETRY_CONTRACT",
    "STATUS_CAPTURE_REFUND_FINANCIAL_FINALITY",
    "PROVIDER_IDEMPOTENCY_AND_LOST_TRACKER_LOOKUP",
    "APPROVED_PROVIDER_VERIFIER_AND_FINANCIAL_RECONCILIATION_ADAPTER",
    "WEBHOOK_KEY_CUSTODY_RETENTION_AND_WORKER_OPERATIONS",
    "EXPIRATION_WORKER_AND_PROVIDER_ACTIVE_HOLD_RESOLUTION",
    "POSTGRES_MIGRATION_REHEARSAL_AND_AUTHORIZED_DEPLOYMENT",
    "CUSTOMER_AUTHORIZATION_AND_RETURN_UI_NOT_CONNECTED",
  ]),
});

// Allows hosted-session creation against sandbox only. It does not activate the
// production flow, payment verification, settlement, webhooks, or reconciliation.
export const SAFEPAY_SANDBOX_SESSION_ENABLED = true as const;

// Refund submissions are sandbox-scoped by the same code-gate pattern as verification:
// no environment variable or admin setting can widen this scope. Production refunds
// stay hard-disabled until the open provider questions are answered (refund endpoint
// idempotency, per-refund identifiers, method support, failure codes, sandbox webhook
// triggering) and the hosted profile blockers above clear.
export const SAFEPAY_REFUNDS_SANDBOX_ONLY = true as const;
