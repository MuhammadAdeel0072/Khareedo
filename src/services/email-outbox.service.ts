// Email outbox (PR-09 security-review fix).
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
// Token custody: the raw reset token is NOT stored in the outbox. The worker
// generates it at delivery time, stores only its SHA-256 hash (in
// PasswordResetToken, as before), and sends the raw token in the email. The
// token therefore only ever exists in the worker's memory and in the email.
// Rows with a null userId are no-ops (unregistered / OAuth-only addresses)
// that the worker discards without sending anything.
//
// Delivery safety:
// - Single-flight within a process (the worker never runs two sweeps at once).
// - Rows are claimed atomically (conditional update on status + nextAttemptAt)
//   so two instances racing on the same row cannot both deliver it.
// - Failed sends retry with exponential backoff (30s, 1m, 2m, 4m, 8m) up to
//   MAX_ATTEMPTS, then the row is marked FAILED and an error is captured for
//   operators. A FAILED row is never retried automatically.
// - The worker never logs tokens, email bodies, or customer data — only the
//   outbox row id and the error name.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { sendPasswordResetEmail } from "@/services/email.service";
import { captureError } from "@/lib/error-monitoring";
import {
  PASSWORD_RESET_TOKEN_TTL_MS,
  hashPasswordResetToken,
} from "@/services/password-reset.service";

export const EMAIL_OUTBOX_TYPE_PASSWORD_RESET = "PASSWORD_RESET";
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
  userId: string | null;
  email: string;
  name: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
};

/** Enqueue a password reset email. The caller passes userId null for an
 * unregistered or OAuth-only address; the worker discards such rows without
 * sending anything. The write is the same single INSERT for every address,
 * so the endpoint's timing does not depend on account existence. */
export async function enqueuePasswordResetEmail(input: {
  userId: string | null;
  email: string;
  name: string | null;
}) {
  await db.emailOutbox.create({
    data: {
      type: EMAIL_OUTBOX_TYPE_PASSWORD_RESET,
      userId: input.userId,
      email: input.email,
      name: input.name,
    },
  });
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
      const attempts = row.attempts + 1;
      const permanentlyFailed = attempts >= EMAIL_OUTBOX_MAX_ATTEMPTS;
      if (permanentlyFailed) result.permanentlyFailed += 1;
      await db.emailOutbox.update({
        where: { id: row.id },
        data: {
          attempts,
          status: permanentlyFailed ? "FAILED" : "PENDING",
          nextAttemptAt: permanentlyFailed ? row.nextAttemptAt : new Date(now.getTime() + backoffMs(attempts)),
          lastError: error instanceof Error ? error.name : "UnknownError",
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

async function deliverOutboxRow(
  row: EmailOutboxRow,
  now: Date
): Promise<"delivered" | "discarded"> {
  // No-op rows (unregistered / OAuth-only addresses) and unknown types are
  // discarded without sending anything.
  if (row.type !== EMAIL_OUTBOX_TYPE_PASSWORD_RESET || !row.userId) {
    await db.emailOutbox.delete({ where: { id: row.id } });
    return "discarded";
  }

  // The user may have been deleted or converted to OAuth-only since the
  // request was enqueued; in that case there is nothing to send.
  const user = await db.user.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true, name: true, passwordHash: true },
  });
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

  await db.emailOutbox.delete({ where: { id: row.id } });
  return "delivered";
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
    try {
      const result = await deliverPendingOutboxEmails(batch);
      if (result.considered > 0) {
        log(
          `[email-outbox] considered=${result.considered} delivered=${result.delivered} discarded=${result.discarded} failed=${result.failed} permanentlyFailed=${result.permanentlyFailed}`
        );
      }
    } catch (error) {
      captureError(error, { operation: "email-outbox-sweep" });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
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
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export function startEmailOutboxWorker(options: {
  intervalMs?: number;
  initialDelayMs?: number;
} = {}): void {
  createEmailOutboxWorker(options).start();
}
