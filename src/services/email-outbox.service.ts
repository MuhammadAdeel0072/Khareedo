// Email outbox (PR-09 security-review fix; extended in Phase 3 Chunk 7 to
// carry registration/resend verification mail as well as password resets).
//
// Why this exists: the forgot-password endpoint must be indistinguishable
// for registered, unregistered, and OAuth-only email addresses. Sending the
// reset email synchronously from the endpoint leaks account existence twice:
// (1) timing — a registered account triggers a DB write plus an SMTP
// round-trip, while an unknown address returns in a few milliseconds; and
// (2) SMTP failures — a 503 (or a slow failure) for a registered account
// versus a 200 for an unknown one. Identical response text is not enough.
//
// So the endpoint never sends email. It enqueues one outbox row — the same
// single DB write for every address — and returns the same 200 immediately.
// A background worker delivers the email. SMTP failures happen in the
// background, are retried with backoff, and never reach the HTTP response.
//
// The same pattern now carries verification mail (Chunk 7, M-24): registration
// used to send the verification email synchronously, so a transient SMTP
// failure failed the whole registration. Registration now only enqueues a row
// and always succeeds; the worker delivers the email with the same retries.
// The worker generates the verification token at delivery time, exactly as
// it does for password resets — the raw token only ever exists in the
// worker's memory and in the email.
//
// Token custody: the raw reset token is NOT stored in the outbox. The worker
// generates it at delivery time, stores only its SHA-256 hash (in
// PasswordResetToken, as before), and sends the raw token in the email. The
// token therefore only ever exists in the worker's memory and in the email.
// The outbox row carries only the submitted email address — no userId, no
// name, no account lookup result — so the row itself cannot encode whether
// an account exists. The worker performs the account lookup AFTER the HTTP
// request has returned, and silently discards unknown and OAuth-only
// addresses without sending anything.
//
// One deliberate limitation of the outbox row shape (Chunk 7, M-24) used to
// be that a row carried only type + email — there was no payload column —
// so a verification email delivered from the outbox could not carry the
// request's callbackUrl. Verification links therefore used the default
// "/account" destination instead of the caller's callbackUrl. That is fixed
// in Chunk 7-final (D14): EmailOutbox now has a nullable `payload` JSON
// column. Verification rows may carry { callbackUrl } there, and order
// notification rows always carry the order snapshot the worker needs to
// render the email (order id/reference/total/status, refund amount). Auth
// rows still carry no payload unless a callbackUrl was supplied.
//
// Delivery safety:
// - Single-flight within a process (the worker never runs two sweeps at once).
// - Rows are claimed atomically (conditional update on status + nextAttemptAt)
//   so two instances racing on the same row cannot both deliver it.
// - Failed sends retry with exponential backoff (30s, 1m, 2m, 4m, 8m) up to
//   MAX_ATTEMPTS, then the row is marked FAILED and an error is captured for
//   operators. A FAILED row is never retried automatically.
// - Permanent failures fail immediately, without burning retries:
//   classifyEmailSendError (email.service.ts) distinguishes them —
//   unconfigured SMTP, SMTP auth failure (535/EAUTH), and invalid
//   recipients (EENVELOPE / 5xx) go FAILED on the first attempt with a clear
//   lastError; only transient errors (timeouts, connection resets) retry
//   with backoff. A sweep also checks isEmailDeliveryConfigured() up front,
//   so unconfigured rows go FAILED immediately instead of retrying for ~15 min.
// - Duplicate prevention: after a successful send the row is marked SENT
//   (conditional update on status PENDING) BEFORE it is deleted, so a crash
//   between the mark and the delete cannot cause a re-send — a SENT row is
//   never swept again and is cleaned up by retention after 30 days. The
//   residual at-least-once window is the single step between sendMail
//   succeeding and the SENT mark landing: a crash exactly there leaves the
//   row PENDING and the next sweep re-sends. That window cannot be closed
//   without a provider-side idempotency key (nodemailer SMTP has none) or a
//   schema change; it is one DB round-trip wide and the token rows are
//   regenerated idempotently, so a duplicate would carry a fresh token and
//   only the latest token is usable.
// - The worker never logs tokens, email bodies, or customer data — only the
//   outbox row id and the error name.
//
// OPERATOR NOTE — SMTP configuration (live delivery is BLOCKED BY
// CONFIGURATION until these are supplied; names only, never values here):
// the sandbox .env has NO SMTP_* variables at all, so no email can be
// delivered from this environment. Supply in the deployment environment:
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
// (see .env.example; NEXTAUTH_URL is also required by smtpConfiguration()).
// Until they are set, every due row fails fast to FAILED with
// "Email delivery is not configured" and no send is attempted. Fixing the
// variables takes effect on the next sweep; a bad SMTP_USER/SMTP_PASSWORD
// is also un-cached on auth failure (resetEmailTransporter), so no restart
// is needed to pick up corrected credentials.
//
// ORDER_PAYMENT_FAILED honesty note (D5 pending): that email can only fire
// on a verified FAILURE_CONFIRMED settlement observation, and no production
// adapter emits FAILURE_CONFIRMED today (verification.ts: a payment.failed
// webhook never yields it). The hook is wired; the signal must come from
// Safepay support's answer, not from an invented decline signal.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import {
  classifyEmailSendError,
  isEmailDeliveryConfigured,
  resetEmailTransporter,
  sendOrderCancelledEmail,
  sendOrderConfirmedEmail,
  sendOrderPaymentFailedEmail,
  sendOrderPaymentSucceededEmail,
  sendOrderRefundSucceededEmail,
  sendOrderStatusEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/services/email.service";
import { findUserByEmail } from "@/services/auth-users.service";
import { captureError, capturePaymentAlert } from "@/lib/error-monitoring";
import {
  recordOutboxSweepFailed,
  recordOutboxSweepStarted,
  recordOutboxSweepSucceeded,
  recordOutboxWorkerStarted,
  recordOutboxWorkerStopped,
} from "@/services/worker-heartbeat";
import {
  PASSWORD_RESET_TOKEN_TTL_MS,
  hashPasswordResetToken,
} from "@/services/password-reset.service";
import {
  VERIFICATION_TOKEN_TTL_MS,
  hashVerificationToken,
} from "@/services/email-verification.service";

export const EMAIL_OUTBOX_TYPE_PASSWORD_RESET = "PASSWORD_RESET";
export const EMAIL_OUTBOX_TYPE_EMAIL_VERIFICATION = "EMAIL_VERIFICATION";
// Order notifications (Phase 3, Chunk 7-final — D14/H-14). Every order row
// carries a JSON payload with the order snapshot the worker renders from
// (see order-notification.service.ts); the row's email column is the
// recipient. Unknown types are discarded at delivery, so a new type must
// be routed in deliverOutboxRow below as well as listed here.
export const EMAIL_OUTBOX_TYPE_ORDER_CONFIRMED = "ORDER_CONFIRMED";
export const EMAIL_OUTBOX_TYPE_ORDER_STATUS = "ORDER_STATUS";
export const EMAIL_OUTBOX_TYPE_ORDER_CANCELLED = "ORDER_CANCELLED";
export const EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_SUCCEEDED = "ORDER_PAYMENT_SUCCEEDED";
export const EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_FAILED = "ORDER_PAYMENT_FAILED";
export const EMAIL_OUTBOX_TYPE_ORDER_REFUND_SUCCEEDED = "ORDER_REFUND_SUCCEEDED";
export const EMAIL_OUTBOX_ORDER_TYPES = [
  EMAIL_OUTBOX_TYPE_ORDER_CONFIRMED,
  EMAIL_OUTBOX_TYPE_ORDER_STATUS,
  EMAIL_OUTBOX_TYPE_ORDER_CANCELLED,
  EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_SUCCEEDED,
  EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_FAILED,
  EMAIL_OUTBOX_TYPE_ORDER_REFUND_SUCCEEDED,
] as const;

/** Human label for the admin outbox viewer (list + detail). Unknown types
 * render as their raw value so a future type is never invisible. */
export function emailOutboxTypeLabel(type: string): string {
  switch (type) {
    case EMAIL_OUTBOX_TYPE_PASSWORD_RESET:
      return "Password reset";
    case EMAIL_OUTBOX_TYPE_EMAIL_VERIFICATION:
      return "Email verification";
    case EMAIL_OUTBOX_TYPE_ORDER_CONFIRMED:
      return "Order confirmation";
    case EMAIL_OUTBOX_TYPE_ORDER_STATUS:
      return "Order status update";
    case EMAIL_OUTBOX_TYPE_ORDER_CANCELLED:
      return "Order cancellation";
    case EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_SUCCEEDED:
      return "Payment success";
    case EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_FAILED:
      return "Payment failure";
    case EMAIL_OUTBOX_TYPE_ORDER_REFUND_SUCCEEDED:
      return "Refund success";
    default:
      return type;
  }
}

/** The order reference carried in an order notification's payload, for the
 * admin outbox detail page. Returns null when the row has no parseable
 * order payload (auth rows, malformed rows). */
export function emailOutboxOrderReference(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && "reference" in parsed &&
        typeof (parsed as { reference?: unknown }).reference === "string") {
      return (parsed as { reference: string }).reference;
    }
    return null;
  } catch {
    return null;
  }
}
export const EMAIL_OUTBOX_MAX_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 5 * 60 * 1000; // a crashed worker's row is retried after 5 min
const MAX_BACKOFF_MS = 15 * 60 * 1000;

function backoffMs(attempts: number) {
  // attempts is the count AFTER this failure: 1 -> 30s, 2 -> 1m, 3 -> 2m, ...
  return Math.min(30_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

export type EmailOutboxRow = {
  id: string;
  type: string;
  email: string;
  payload: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
};

/**
 * Enqueue one outbox row for (type, email), deduped (M-25): if a PENDING row
 * for the same type and email already exists, do nothing and return — a rapid
 * repeat request (double submit, resend click) must not queue a second email.
 * Delivered rows are deleted on delivery, so only PENDING rows are
 * observable here; re-sends after a delivery are bounded by the caller's own
 * rate limit (forgot-password: 3/hour per email; resend: 3/hour per email).
 * The check is a read followed by a conditional create, not atomic — two
 * requests racing in the same instant can both enqueue, and the worker then
 * delivers both (the second token replaces the first). That race is bounded
 * by the same per-email rate limits and is harmless: only the latest token
 * is usable. Making it atomic needs a unique index on
 * (type, email[, payload]) — a migration another stream owns — or a
 * serializable transaction, which Prisma cannot express for a conditional
 * create without that index. Until the index exists, the read-then-create
 * plus the per-email rate limit is the strongest available guarantee; the
 * dedup key itself (type, email[, payload]) is unchanged.
 *
 * Rows WITH a payload (order notifications, verification with a
 * callbackUrl) dedup on (type, email, payload): two different orders for
 * the same customer must not collapse into one row, and two different
 * callbackUrls are different emails. Rows without a payload keep the old
 * (type, email) dedup exactly.
 */
async function enqueueOutboxEmail(type: string, email: string, payload?: string | null): Promise<void> {
  const existing = await db.emailOutbox.findFirst({
    where: { type, email, status: "PENDING", ...(payload ? { payload } : {}) },
    select: { id: true },
  });
  if (existing) return;
  await db.emailOutbox.create({ data: { type, email, ...(payload ? { payload } : {}) } });
}

/** Enqueue one order-notification row (Chunk 7-final — D14). The payload is
 * the JSON snapshot the worker renders from (see
 * order-notification.service.ts); it is part of the dedup key, so the same
 * event for the same order never enqueues twice while PENDING. Exported for
 * the notification service — all order enqueue points go through it. */
export async function enqueueOrderNotificationEmail(input: {
  type: string;
  email: string;
  payload: string;
}): Promise<void> {
  await enqueueOutboxEmail(input.type, input.email, input.payload);
}

/** Enqueue a password reset email. Carries only the submitted normalized
 * email address — no account lookup, no userId, no name — so the row is
 * identical for every valid email and cannot encode whether an account
 * exists. The worker looks the account up after the HTTP request has
 * returned. */
export async function enqueuePasswordResetEmail(input: { email: string }) {
  await enqueueOutboxEmail(EMAIL_OUTBOX_TYPE_PASSWORD_RESET, input.email);
}

/** Enqueue a registration/resend verification email (Chunk 7, M-24). Same
 * shape as the reset row: only the email. The worker looks the account up
 * at delivery, generates the token then, and sends the email. A caller
 * supplied callbackUrl is carried in the payload (Chunk 7-final): the
 * worker uses it as the post-verification destination instead of the
 * default "/account". */
export async function enqueueVerificationEmail(input: { email: string; callbackUrl?: string | null }) {
  const payload = input.callbackUrl
    ? JSON.stringify({ callbackUrl: input.callbackUrl })
    : null;
  await enqueueOutboxEmail(EMAIL_OUTBOX_TYPE_EMAIL_VERIFICATION, input.email, payload);
}

export type OutboxDeliveryResult = {
  considered: number;
  delivered: number;
  discarded: number;
  failed: number;
  permanentlyFailed: number;
};

/**
 * Deliver pending outbox emails (one sweep). Exported so tests and the admin
 * path can invoke delivery directly without waiting for the interval.
 * Returns counts, never tokens or email bodies.
 */
export async function deliverPendingOutboxEmails(
  batch = 10,
  now = new Date()
): Promise<OutboxDeliveryResult> {
  const result: OutboxDeliveryResult = {
    considered: 0,
    delivered: 0,
    discarded: 0,
    failed: 0,
    permanentlyFailed: 0,
  };

  const pending = await db.emailOutbox.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: batch,
  });

  // Fail fast when SMTP is not configured: isEmailDeliveryConfigured() is
  // consulted once per sweep (not per row) so unconfigured rows go FAILED
  // immediately instead of burning 5 attempts over ~15 minutes. Any
  // configuration error — missing variables AND a half-configured
  // SMTP_USER/SMTP_PASSWORD pair, which isEmailDeliveryConfigured() throws
  // for — is terminal here. This also covers rows that would have been
  // silently discarded (unknown/OAuth addresses): they become FAILED with
  // the config error instead, and a manual retry after SMTP is fixed
  // re-processes them into a discard. No send is attempted for any row.
  const configState = emailDeliveryConfigState();
  if (!configState.configured) {
    for (const row of pending) {
      result.considered += 1;
      result.failed += 1;
      result.permanentlyFailed += 1;
      await db.emailOutbox.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: {
          attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
          status: "FAILED",
          lastError: configState.reason.slice(0, 500),
        },
      });
    }
    if (pending.length > 0) {
      // One monitoring event per sweep, not one per row: N identical
      // config failures would otherwise spam the alert throttle.
      const error = new Error(configState.reason);
      error.name = "EmailDeliveryNotConfiguredError";
      captureError(error, {
        operation: "email-outbox-delivery",
        eventId: `unconfigured-sweep:${pending.length}`,
      });
    }
    return result;
  }

  for (const row of pending) {
    result.considered += 1;
    // Claim the row atomically so two instances cannot both deliver it.
    const claimed = await db.emailOutbox.updateMany({
      where: { id: row.id, status: "PENDING", nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (claimed.count !== 1) continue;

    try {
      const outcome = await deliverOutboxRow(row, now);
      if (outcome === "delivered") result.delivered += 1;
      else result.discarded += 1;
    } catch (error) {
      result.failed += 1;
      const classification = classifyEmailSendError(error);
      // A permanent failure (unconfigured SMTP, auth failure, invalid
      // recipient) goes FAILED on the first attempt — retrying the same
      // send cannot succeed. Only transient failures consume the backoff
      // budget. An auth failure also drops the cached transporter so
      // corrected credentials take effect without a restart.
      if (classification.authFailure) {
        resetEmailTransporter();
      }
      const attempts = classification.permanent
        ? EMAIL_OUTBOX_MAX_ATTEMPTS
        : row.attempts + 1;
      const permanentlyFailed = attempts >= EMAIL_OUTBOX_MAX_ATTEMPTS;
      if (permanentlyFailed) result.permanentlyFailed += 1;
      // Conditional on status PENDING: if the row was already marked SENT
      // (send succeeded, then the delete threw), this update is a no-op
      // and the row stays SENT instead of being resurrected to PENDING
      // and re-sent on the next sweep.
      await db.emailOutbox.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: {
          attempts,
          status: permanentlyFailed ? "FAILED" : "PENDING",
          nextAttemptAt: permanentlyFailed ? row.nextAttemptAt : new Date(now.getTime() + backoffMs(attempts)),
          // lastError carried only the error NAME (Phase 3, chunk 12
          // follow-up B) — "Error" tells the admin nothing. Store the
          // full message so the failure is diagnosable from the outbox
          // viewer, capped at 500 chars so a pathological message
          // cannot bloat the row. Permanent failures prefix the
          // classification reason so the admin sees WHY it will not retry.
          lastError: (
            classification.permanent
              ? `${classification.reason} ${error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError"}`
              : error instanceof Error
                ? `${error.name}: ${error.message}`
                : "UnknownError"
          ).slice(0, 500),
        },
      });
      if (permanentlyFailed) {
        captureError(error, {
          operation: "email-outbox-delivery",
          eventId: row.id,
        });
      }
    }
  }

  return result;
}

/**
 * Whether email delivery is configured, as a sweep-level verdict.
 * isEmailDeliveryConfigured() returns false for missing variables but
 * THROWS for a half-configured SMTP_USER/SMTP_PASSWORD pair — both are
 * terminal config failures for the outbox, so both map to configured:false
 * with a reason the admin can act on.
 */
function emailDeliveryConfigState(): { configured: boolean; reason: string } {
  try {
    if (isEmailDeliveryConfigured()) return { configured: true, reason: "" };
    return {
      configured: false,
      reason:
        "EmailDeliveryNotConfiguredError: Email delivery is not configured. " +
        "Set SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM (and NEXTAUTH_URL).",
    };
  } catch (error) {
    return {
      configured: false,
      reason:
        error instanceof Error
          ? `EmailDeliveryNotConfiguredError: ${error.message}`
          : "EmailDeliveryNotConfiguredError: Email delivery is not configured.",
    };
  }
}

/**
 * Mark a row SENT after a successful send, before deleting it. The
 * conditional update is the duplicate guard: only a row still PENDING is
 * marked, so a concurrent retry/reset cannot mark a row that already
 * delivered. A SENT row is never swept again (sweeps only read PENDING),
 * so even if the delete that follows throws or the process crashes, the
 * email is not sent twice. SENT rows are removed by the 30-day retention
 * cleanup if the delete never lands. Discards (no email sent) delete
 * directly — re-discard on the next sweep is harmless and idempotent.
 */
async function markOutboxRowSent(rowId: string): Promise<void> {
  await db.emailOutbox.updateMany({
    where: { id: rowId, status: "PENDING" },
    data: { status: "SENT" },
  });
}

async function deliverOutboxRow(
  row: EmailOutboxRow,
  now: Date
): Promise<"delivered" | "discarded"> {
  // Unknown types are discarded without sending anything.
  if (row.type === EMAIL_OUTBOX_TYPE_PASSWORD_RESET) {
    return deliverPasswordResetRow(row, now);
  }
  if (row.type === EMAIL_OUTBOX_TYPE_EMAIL_VERIFICATION) {
    return deliverVerificationRow(row, now);
  }
  if ((EMAIL_OUTBOX_ORDER_TYPES as readonly string[]).includes(row.type)) {
    return deliverOrderNotificationRow(row);
  }
  await db.emailOutbox.delete({ where: { id: row.id } });
  return "discarded";
}

/**
 * Deliver an order notification (Chunk 7-final — D14). The payload is the
 * snapshot taken at enqueue time — order id/reference/total/status, refund
 * amount — so delivery never re-reads the order and the email always
 * reflects the event, even if the order changed afterwards. A missing or
 * unparseable payload is a bug, not a discard: throwing here retries with
 * backoff and ends FAILED with the reason visible in the admin viewer,
 * instead of silently dropping a customer's order email. The row is
 * deleted only after the send succeeds, so a crash mid-delivery retries
 * instead of losing the email.
 */
async function deliverOrderNotificationRow(
  row: EmailOutboxRow
): Promise<"delivered" | "discarded"> {
  const payload = parseOrderNotificationPayload(row);
  const base = {
    email: row.email,
    name: payload.customerName,
    reference: payload.reference,
    orderId: payload.orderId,
    total: payload.total,
    paymentMethod: payload.paymentMethod,
  };
  switch (row.type) {
    case EMAIL_OUTBOX_TYPE_ORDER_CONFIRMED:
      await sendOrderConfirmedEmail(base);
      break;
    case EMAIL_OUTBOX_TYPE_ORDER_STATUS:
      await sendOrderStatusEmail({
        ...base,
        status: payload.status,
        carrier: payload.carrier ?? null,
        trackingNumber: payload.trackingNumber ?? null,
      });
      break;
    case EMAIL_OUTBOX_TYPE_ORDER_CANCELLED:
      await sendOrderCancelledEmail(base);
      break;
    case EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_SUCCEEDED:
      await sendOrderPaymentSucceededEmail(base);
      break;
    case EMAIL_OUTBOX_TYPE_ORDER_PAYMENT_FAILED:
      await sendOrderPaymentFailedEmail(base);
      break;
    case EMAIL_OUTBOX_TYPE_ORDER_REFUND_SUCCEEDED:
      await sendOrderRefundSucceededEmail({
        ...base,
        refundAmountMinor: BigInt(payload.refundAmountMinor),
      });
      break;
    default:
      // Unreachable: deliverOutboxRow routes only known order types here.
      throw new Error(`Unknown order notification type: ${row.type}`);
  }
  await markOutboxRowSent(row.id);
  await db.emailOutbox.delete({ where: { id: row.id } });
  return "delivered";
}

type OrderNotificationPayload = {
  orderId: string;
  reference: string;
  customerName: string | null;
  total: number;
  paymentMethod: string;
  status: string;
  carrier?: string | null;
  trackingNumber?: string | null;
  refundAmountMinor: string;
};

function parseOrderNotificationPayload(row: EmailOutboxRow): OrderNotificationPayload {
  let parsed: unknown = null;
  try {
    parsed = row.payload ? JSON.parse(row.payload) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Order notification ${row.id} has no usable payload.`);
  }
  const p = parsed as Record<string, unknown>;
  const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const isSafeTotal = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (
    !isNonEmptyString(p.orderId) ||
    !isNonEmptyString(p.reference) ||
    !isSafeTotal(p.total) ||
    !isNonEmptyString(p.paymentMethod) ||
    (p.customerName !== null && typeof p.customerName !== "string")
  ) {
    throw new Error(`Order notification ${row.id} has an incomplete payload.`);
  }
  if (row.type === EMAIL_OUTBOX_TYPE_ORDER_STATUS && !isNonEmptyString(p.status)) {
    throw new Error(`Order status notification ${row.id} has no status in its payload.`);
  }
  if (
    row.type === EMAIL_OUTBOX_TYPE_ORDER_REFUND_SUCCEEDED &&
    (typeof p.refundAmountMinor !== "string" || !/^\d+$/.test(p.refundAmountMinor))
  ) {
    throw new Error(`Refund notification ${row.id} has no refund amount in its payload.`);
  }
  return {
    orderId: p.orderId,
    reference: p.reference,
    customerName: (p.customerName as string | null) ?? null,
    total: p.total,
    paymentMethod: p.paymentMethod,
    status: typeof p.status === "string" ? p.status : "",
    carrier: typeof p.carrier === "string" ? p.carrier : null,
    trackingNumber: typeof p.trackingNumber === "string" ? p.trackingNumber : null,
    refundAmountMinor: typeof p.refundAmountMinor === "string" ? p.refundAmountMinor : "0",
  };
}

async function deliverPasswordResetRow(
  row: EmailOutboxRow,
  now: Date
): Promise<"delivered" | "discarded"> {

  // The account lookup happens here, in the background, AFTER the HTTP
  // request has returned — never in the request path. Unknown and
  // OAuth-only addresses are silently discarded; only credentials accounts
  // receive a token and an email.
  const user = await findUserByEmail(row.email);
  if (!user || !user.passwordHash) {
    await db.emailOutbox.delete({ where: { id: row.id } });
    return "discarded";
  }

  // Generate the token here, at delivery time. Only its hash is stored.
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashPasswordResetToken(token);
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

  await db.$transaction(async (transaction) => {
    await transaction.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await transaction.passwordResetToken.create({
      data: { userId: user.id, email: user.email, tokenHash, expiresAt },
    });
  });

  await sendPasswordResetEmail({ email: user.email, name: user.name, token });

  await markOutboxRowSent(row.id);
  await db.emailOutbox.delete({ where: { id: row.id } });
  return "delivered";
}

/**
 * Deliver a verification email (Chunk 7, M-24). Mirrors the reset path: the
 * account lookup happens here, in the background, AFTER the HTTP request
 * returned. Unknown, OAuth-only, and already-verified addresses are
 * silently discarded — only an unverified credentials account receives a
 * token and an email. The token is generated here, at delivery time, and
 * only its hash is stored (same shape as the old synchronous path:
 * 32 random bytes, base64url, SHA-256 hash, 24h TTL, replacing any
 * previous token for the user). The verification link uses the callbackUrl
 * carried in the row's payload when the enqueueing request supplied one
 * (Chunk 7-final), falling back to the default "/account" — the M-24
 * caveat is closed by the payload column.
 */
async function deliverVerificationRow(
  row: EmailOutboxRow,
  now: Date
): Promise<"delivered" | "discarded"> {
  const user = await findUserByEmail(row.email);
  if (!user || !user.passwordHash || user.emailVerified) {
    await db.emailOutbox.delete({ where: { id: row.id } });
    return "discarded";
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashVerificationToken(token);
  const expiresAt = new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS);

  await db.$transaction(async (transaction) => {
    await transaction.verificationToken.deleteMany({ where: { userId: user.id } });
    await transaction.verificationToken.create({
      data: { userId: user.id, email: user.email, tokenHash, expiresAt },
    });
  });

  await sendVerificationEmail({
    email: user.email,
    name: user.name,
    token,
    callbackUrl: verificationCallbackUrl(row),
  });

  await markOutboxRowSent(row.id);
  await db.emailOutbox.delete({ where: { id: row.id } });
  return "delivered";
}

/** The post-verification destination for a verification row: the
 * callbackUrl the enqueueing request supplied, if any, else the default.
 * sendVerificationEmail applies safeCallbackUrl again, so a hostile or
 * malformed value stored here can never redirect off-site. */
function verificationCallbackUrl(row: EmailOutboxRow): string {
  if (!row.payload) return "/account";
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (
      parsed &&
      typeof parsed === "object" &&
      "callbackUrl" in parsed &&
      typeof (parsed as { callbackUrl?: unknown }).callbackUrl === "string" &&
      (parsed as { callbackUrl: string }).callbackUrl.length > 0
    ) {
      return (parsed as { callbackUrl: string }).callbackUrl;
    }
  } catch {
    // A malformed payload must not fail a verification delivery: the token
    // is what matters, and the default destination is safe.
  }
  return "/account";
}

// --- Admin visibility (Phase 3 Chunk 7, H-15) ---------------------------------
//
// A FAILED row used to be visible only in error monitoring (and only when
// it exhausted all retries). The admin outbox viewer lists every row —
// PENDING and FAILED — with its type, recipient, attempts, last error and
// age, so a silently failing reset/verification delivery is visible and an
// admin can retry it. Delivered and discarded rows are deleted by the
// worker, so they never appear here; only rows still needing attention do.

export type EmailOutboxEntry = {
  id: string;
  type: string;
  email: string;
  payload: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
};

export const EMAIL_OUTBOX_STATUSES = ["PENDING", "FAILED"] as const;

export async function listEmailOutboxEntries(input: {
  status?: string;
  page?: number;
  perPage?: number;
}): Promise<{ entries: EmailOutboxEntry[]; total: number; page: number; perPage: number }> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(input.perPage ?? 25)));
  const where: { status?: string } = {};
  if (input.status && (EMAIL_OUTBOX_STATUSES as readonly string[]).includes(input.status)) {
    where.status = input.status;
  }
  const [rows, total] = await Promise.all([
    db.emailOutbox.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.emailOutbox.count({ where }),
  ]);
  return { entries: rows, total, page, perPage };
}

export async function getEmailOutboxEntry(id: string): Promise<EmailOutboxEntry | null> {
  return db.emailOutbox.findUnique({ where: { id } });
}

/**
 * Retry a FAILED row: reset it to PENDING with a full attempt budget and
 * make it due immediately. The conditional update is the claim — it only
 * succeeds when the row is still FAILED, so a double retry (two admins, or
 * a retry racing a worker sweep) cannot reset the row twice or resurrect a
 * row that already delivered. Returns true when the row was retried.
 */
export async function retryEmailOutboxEntry(id: string, now = new Date()): Promise<boolean> {
  const retried = await db.emailOutbox.updateMany({
    where: { id, status: "FAILED" },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lastError: null },
  });
  return retried.count === 1;
}

// --- Retention (Phase 3 Chunk 7, M-23) --------------------------------------
//
// FAILED rows are terminal — nothing retries them automatically — so without
// cleanup they accumulate forever. Rows older than the retention window are
// deleted by the shared maintenance runner (see
// payment-maintenance.service.ts, action "cleanup_email_outbox"). PENDING
// rows are never deleted: they are still actionable work. Delivered and
// discarded rows are already deleted by the worker, so no SENT state exists
// in practice; it is included defensively in case a future type ever marks
// rows SENT instead of deleting them.
//
// No retention convention existed anywhere in the codebase (the audit log
// explicitly documents having none), so 30 days is chosen here and
// documented: long enough to investigate a delivery failure, short enough
// that the table stays small.
export const EMAIL_OUTBOX_RETENTION_DAYS = 30;

export async function cleanupEmailOutboxEntries(
  now = new Date()
): Promise<{ deleted: number }> {
  const cutoff = new Date(
    now.getTime() - EMAIL_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const result = await db.emailOutbox.deleteMany({
    where: { status: { in: ["FAILED", "SENT"] }, createdAt: { lt: cutoff } },
  });
  return { deleted: result.count };
}

// --- Background worker -----------------------------------------------------

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 15_000;
const DEFAULT_INITIAL_DELAY_MS = 15_000;
const DEFAULT_BATCH = 10;

export function createEmailOutboxWorker(options: {
  intervalMs?: number;
  initialDelayMs?: number;
  batch?: number;
  log?: (message: string) => void;
} = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const batch = options.batch ?? DEFAULT_BATCH;
  const log = options.log ?? ((message: string) => console.info(message));
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new Error("Email outbox worker interval must be at least 15 seconds.");
  }
  let running = false;
  let suspended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function sweep(): Promise<void> {
    if (running || suspended) return;
    running = true;
    recordOutboxSweepStarted();
    try {
      const result = await deliverPendingOutboxEmails(batch);
      if (result.considered > 0) {
        log(
          `[email-outbox] considered=${result.considered} delivered=${result.delivered} discarded=${result.discarded} failed=${result.failed} permanentlyFailed=${result.permanentlyFailed}`
        );
      }
      recordOutboxSweepSucceeded();
    } catch (error) {
      // A sweep that throws means the delivery loop itself is broken (the
      // DB read failed, not a single email) — record it in the outbox
      // heartbeat (Stream F) and raise the same WORKER_FAILURE alert the
      // payment worker raises, so the failure is visible in GET /api/health,
      // the admin Operations card, and the alert email. The alert code is
      // OUTBOX_SWEEP_FAILED, not SWEEP_FAILED: the alert throttle is keyed
      // on kind+code, and sharing the payment worker's code would let a
      // payment-worker alert inside the 15-minute throttle window silently
      // suppress this one. The heartbeat code stays the generic
      // SWEEP_FAILED, matching the payment worker. Per-row failures never
      // reach this catch — they retry with backoff inside
      // deliverPendingOutboxEmails — so a failing email does not mark the
      // worker failing.
      recordOutboxSweepFailed("SWEEP_FAILED");
      captureError(error, { operation: "email-outbox-sweep" });
      capturePaymentAlert("WORKER_FAILURE", {
        operation: "email-outbox-sweep",
        code: "OUTBOX_SWEEP_FAILED",
      });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      recordOutboxWorkerStarted();
      timer = setTimeout(() => {
        void sweep();
        timer = setInterval(() => {
          void sweep();
        }, intervalMs);
        timer.unref?.();
      }, initialDelayMs);
      timer.unref?.();
    },
    stop() {
      suspended = true;
      recordOutboxWorkerStopped();
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
        timer = undefined;
      }
    },
    /** Exposed for tests: runs exactly one delivery sweep, bypassing the timer. */
    async sweepOnce(): Promise<void> {
      await sweep();
    },
  };
}

const EMAIL_OUTBOX_WORKER_REGISTRY_KEY = Symbol.for("khareedo.email-outbox-worker");

/** Wires the outbox delivery sweep and starts the worker exactly once per server process. */
export function startEmailOutboxWorker(options: {
  intervalMs?: number;
  initialDelayMs?: number;
} = {}): void {
  // The email outbox worker has its OWN opt-out (EMAIL_OUTBOX_WORKER=off),
  // independent of PAYMENT_MAINTENANCE_WORKER: disabling payment
  // maintenance must not silently disable password-reset email delivery.
  if (process.env.EMAIL_OUTBOX_WORKER === "off") return;
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[EMAIL_OUTBOX_WORKER_REGISTRY_KEY]) return;
  const worker = createEmailOutboxWorker(options);
  registry[EMAIL_OUTBOX_WORKER_REGISTRY_KEY] = worker;
  worker.start();
}
