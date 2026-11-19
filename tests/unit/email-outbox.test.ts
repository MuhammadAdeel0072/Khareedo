// Email outbox delivery tests (PR-09 security-review fix).
//
// The forgot-password endpoint enqueues one outbox row and returns
// immediately; this worker generates the reset token at delivery time,
// stores only its hash, and sends the email. SMTP failures are retried
// with backoff in the background and never reach the HTTP response.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockSendPasswordResetEmail, mockCaptureError } = vi.hoisted(() => ({
  mockDb: {
    emailOutbox: { findMany: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), update: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  mockSendPasswordResetEmail: vi.fn(),
  mockCaptureError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/services/email.service", () => ({
  sendPasswordResetEmail: mockSendPasswordResetEmail,
}));
vi.mock("@/lib/error-monitoring", () => ({
  captureError: mockCaptureError,
}));

import {
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  deliverPendingOutboxEmails,
  enqueuePasswordResetEmail,
} from "@/services/email-outbox.service";
import { hashPasswordResetToken } from "@/services/password-reset.service";

const now = new Date("2026-11-19T12:00:00Z");

function outboxRow(overrides: Partial<{
  id: string;
  type: string;
  userId: string | null;
  email: string;
  name: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "outbox-1",
    type: overrides.type ?? "PASSWORD_RESET",
    userId: overrides.userId === undefined ? "user-1" : overrides.userId,
    email: overrides.email ?? "customer@example.com",
    name: overrides.name ?? "Customer",
    status: overrides.status ?? "PENDING",
    attempts: overrides.attempts ?? 0,
    nextAttemptAt: overrides.nextAttemptAt ?? new Date(now.getTime() - 1_000),
    lastError: null,
  };
}

const customerUser = {
  id: "user-1",
  email: "customer@example.com",
  name: "Customer",
  passwordHash: "hashed-password",
};

function setUpPendingRows(rows: ReturnType<typeof outboxRow>[]) {
  const claimed = new Set<string>();
  mockDb.emailOutbox.findMany.mockResolvedValue(rows);
  // Claim succeeds only the first time for a given row (atomic conditional update).
  mockDb.emailOutbox.updateMany.mockImplementation(
    async ({ where }: { where: { id: string } }) => {
      if (claimed.has(where.id)) return { count: 0 };
      claimed.add(where.id);
      return { count: 1 };
    }
  );
  mockDb.emailOutbox.delete.mockResolvedValue({ id: "deleted" });
  mockDb.emailOutbox.update.mockResolvedValue({ id: "updated" });
  mockDb.user.findUnique.mockResolvedValue(customerUser);
  mockDb.$transaction.mockImplementation(async (callback: (t: unknown) => unknown) => {
    const transaction = {
      passwordResetToken: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => ({ id: "reset-1", ...data })),
      },
    };
    return callback(transaction);
  });
}

describe("email outbox delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendPasswordResetEmail.mockResolvedValue(undefined);
  });

  it("delivers a reset email: creates a hashed token, sends the email, deletes the row", async () => {
    const row = outboxRow();
    setUpPendingRows([row]);

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 1, discarded: 0, failed: 0, permanentlyFailed: 0 });
    // A token row is created in the transaction (hash only).
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    // The raw token is emailed once.
    expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendPasswordResetEmail.mock.calls[0][0];
    expect(sent.email).toBe("customer@example.com");
    expect(typeof sent.token).toBe("string");
    expect(sent.token.length).toBeGreaterThan(20);
    expect(hashPasswordResetToken(sent.token)).toMatch(/^[a-f0-9]{64}$/);
    // The outbox row is deleted after a successful send.
    expect(mockDb.emailOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
    // The raw token is never written to the outbox table.
    expect(mockDb.emailOutbox.create).not.toHaveBeenCalled();
  });

  it("discards a no-op row (unregistered / OAuth-only address) without sending anything", async () => {
    const row = outboxRow({ userId: null, email: "nobody@example.com", name: null });
    setUpPendingRows([row]);

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 1, failed: 0, permanentlyFailed: 0 });
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.emailOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
  });

  it("discards a row for a user who no longer has a password (deleted / OAuth-only since enqueue)", async () => {
    const row = outboxRow();
    setUpPendingRows([row]);
    mockDb.user.findUnique.mockResolvedValue({ ...customerUser, passwordHash: null });

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 1, failed: 0, permanentlyFailed: 0 });
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("an SMTP failure retries with backoff and keeps the row pending (never reveals the failure to the endpoint)", async () => {
    const row = outboxRow();
    setUpPendingRows([row]);
    mockSendPasswordResetEmail.mockRejectedValue(new Error("SMTP connection refused"));

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 0, failed: 1, permanentlyFailed: 0 });
    // The row stays PENDING with attempts=1 and a backoff (30s) before the
    // next attempt — the endpoint already returned 200 and never sees this.
    const update = mockDb.emailOutbox.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: row.id });
    expect(update.data.attempts).toBe(1);
    expect(update.data.status).toBe("PENDING");
    expect(update.data.nextAttemptAt.getTime() - now.getTime()).toBe(30_000);
    expect(update.data.lastError).toBe("Error");
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it("marks the row FAILED after the maximum attempts and captures an error for operators", async () => {
    const row = outboxRow({ attempts: EMAIL_OUTBOX_MAX_ATTEMPTS - 1 });
    setUpPendingRows([row]);
    mockSendPasswordResetEmail.mockRejectedValue(new Error("SMTP connection refused"));

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 0, failed: 1, permanentlyFailed: 1 });
    const update = mockDb.emailOutbox.update.mock.calls[0][0];
    expect(update.data.attempts).toBe(EMAIL_OUTBOX_MAX_ATTEMPTS);
    expect(update.data.status).toBe("FAILED");
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
  });

  it("does not deliver a row that is not yet due (nextAttemptAt in the future)", async () => {
    const row = outboxRow({ nextAttemptAt: new Date(now.getTime() + 60_000) });
    // findMany only returns due rows, so an empty list means nothing is due.
    mockDb.emailOutbox.findMany.mockResolvedValue([]);

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result.considered).toBe(0);
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(row).toBeDefined();
  });

  it("enqueues a password reset email as a single outbox row", async () => {
    mockDb.emailOutbox.create.mockResolvedValue({ id: "outbox-new" });

    await enqueuePasswordResetEmail({ userId: "user-1", email: "customer@example.com", name: "Customer" });

    expect(mockDb.emailOutbox.create).toHaveBeenCalledWith({
      data: {
        type: "PASSWORD_RESET",
        userId: "user-1",
        email: "customer@example.com",
        name: "Customer",
      },
    });
  });
});
