// Email outbox delivery tests (PR-09 security-review fix).
//
// The forgot-password endpoint enqueues one outbox row carrying only the
// submitted email address and returns immediately; this worker performs the
// account lookup AFTER the HTTP request has returned, generates the reset
// token at delivery time, stores only its hash, and sends the email. SMTP
// failures are retried with backoff in the background and never reach the
// HTTP response.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockSendPasswordResetEmail, mockSendVerificationEmail, mockCaptureError, mockCapturePaymentAlert, mockFindUserByEmail, mockIsEmailDeliveryConfigured, mockClassifyEmailSendError, mockResetEmailTransporter } = vi.hoisted(() => ({
  mockDb: {
    emailOutbox: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockSendPasswordResetEmail: vi.fn(),
  mockSendVerificationEmail: vi.fn(),
  mockCaptureError: vi.fn(),
  mockCapturePaymentAlert: vi.fn(),
  mockFindUserByEmail: vi.fn(),
  mockIsEmailDeliveryConfigured: vi.fn(),
  // Mirrors the real classifyEmailSendError rules for the error shapes
  // these tests use; the real classifier is covered exhaustively in
  // email-send-classifier.test.ts against the real email.service module.
  mockClassifyEmailSendError: vi.fn((error: unknown) => {
    const err = error as { code?: string; responseCode?: number; name?: string };
    if (err?.name === "EmailDeliveryNotConfiguredError") {
      return { kind: "permanent", permanent: true, authFailure: false, reason: "Email delivery is not configured." };
    }
    if (err?.code === "EAUTH" || err?.responseCode === 535) {
      return { kind: "permanent", permanent: true, authFailure: true, reason: "SMTP authentication failed — check SMTP_USER/SMTP_PASSWORD." };
    }
    if (err?.code === "EENVELOPE" || err?.responseCode === 550) {
      return { kind: "permanent", permanent: true, authFailure: false, reason: "Invalid recipient — the SMTP server permanently rejected the address." };
    }
    return { kind: "transient", permanent: false, authFailure: false, reason: "Transient email delivery failure — will retry with backoff." };
  }),
  mockResetEmailTransporter: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/services/email.service", () => ({
  isEmailDeliveryConfigured: mockIsEmailDeliveryConfigured,
  classifyEmailSendError: mockClassifyEmailSendError,
  resetEmailTransporter: mockResetEmailTransporter,
  sendPasswordResetEmail: mockSendPasswordResetEmail,
  sendVerificationEmail: mockSendVerificationEmail,
}));
vi.mock("@/lib/error-monitoring", () => ({
  captureError: mockCaptureError,
  capturePaymentAlert: mockCapturePaymentAlert,
}));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mockFindUserByEmail,
}));

import {
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  cleanupEmailOutboxEntries,
  deliverPendingOutboxEmails,
  enqueuePasswordResetEmail,
  enqueueVerificationEmail,
  getEmailOutboxEntry,
  listEmailOutboxEntries,
  retryEmailOutboxEntry,
  startEmailOutboxWorker,
} from "@/services/email-outbox.service";
import { hashPasswordResetToken } from "@/services/password-reset.service";
import { hashVerificationToken } from "@/services/email-verification.service";

const now = new Date("2026-11-19T12:00:00Z");

function outboxRow(overrides: Partial<{
  id: string;
  type: string;
  email: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? "outbox-1",
    type: overrides.type ?? "PASSWORD_RESET",
    email: overrides.email ?? "customer@example.com",
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
  // updateMany serves three calls: the atomic claim (data: nextAttemptAt
  // only — succeeds only the first time per row), the SENT mark after a
  // successful send (data.status SENT), and the failure-path update
  // (data.attempts present). The mock tells them apart by data shape.
  mockDb.emailOutbox.updateMany.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { status?: string; attempts?: number } }) => {
      if (data?.status === "SENT") return { count: 1 };
      if (typeof data?.attempts === "number") return { count: 1 };
      if (claimed.has(where.id)) return { count: 0 };
      claimed.add(where.id);
      return { count: 1 };
    }
  );
  mockDb.emailOutbox.delete.mockResolvedValue({ id: "deleted" });
  mockDb.emailOutbox.update.mockResolvedValue({ id: "updated" });
  mockFindUserByEmail.mockResolvedValue(customerUser);
  mockDb.$transaction.mockImplementation(async (callback: (t: unknown) => unknown) => {
    const transaction = {
      passwordResetToken: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => ({ id: "reset-1", ...data })),
      },
      verificationToken: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => ({ id: "verify-1", ...data })),
      },
    };
    return callback(transaction);
  });
}

/** The failure-path updateMany call (the one whose data carries attempts). */
function failureUpdate() {
  const call = mockDb.emailOutbox.updateMany.mock.calls.find((args) => {
    const data = (args[0] as { data?: { attempts?: number } }).data;
    return typeof data?.attempts === "number";
  });
  expect(call).toBeDefined();
  return call![0] as {
    where: { id: string; status: string };
    data: { attempts: number; status: string; nextAttemptAt: Date; lastError: string };
  };
}

/** The SENT-mark updateMany call (the one whose data sets status SENT). */
function sentMarkUpdate() {
  const call = mockDb.emailOutbox.updateMany.mock.calls.find((args) => {
    const data = (args[0] as { data?: { status?: string } }).data;
    return data?.status === "SENT";
  });
  expect(call).toBeDefined();
  return call![0] as { where: { id: string; status: string }; data: { status: string } };
}

describe("email outbox delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendPasswordResetEmail.mockResolvedValue(undefined);
    mockSendVerificationEmail.mockResolvedValue(undefined);
    mockIsEmailDeliveryConfigured.mockReturnValue(true);
    // No PENDING row exists by default, so enqueueing creates one.
    mockDb.emailOutbox.findFirst.mockResolvedValue(null);
  });

  it("delivers a reset email: looks the account up, creates a hashed token, sends the email, deletes the row", async () => {
    const row = outboxRow();
    setUpPendingRows([row]);

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 1, discarded: 0, failed: 0, permanentlyFailed: 0 });
    // The worker performs the account lookup (after the HTTP request returned).
    expect(mockFindUserByEmail).toHaveBeenCalledWith("customer@example.com");
    // A token row is created in the transaction (hash only).
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    // The raw token is emailed once.
    expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendPasswordResetEmail.mock.calls[0][0];
    expect(sent.email).toBe("customer@example.com");
    expect(typeof sent.token).toBe("string");
    expect(sent.token.length).toBeGreaterThan(20);
    expect(hashPasswordResetToken(sent.token)).toMatch(/^[a-f0-9]{64}$/);
    // The row is marked SENT (conditional on still PENDING) BEFORE it is
    // deleted, so a crash between the mark and the delete cannot re-send it.
    const mark = sentMarkUpdate();
    expect(mark.where).toEqual({ id: row.id, status: "PENDING" });
    expect(mark.data).toEqual({ status: "SENT" });
    const markOrder = mockDb.emailOutbox.updateMany.mock.invocationCallOrder[
      mockDb.emailOutbox.updateMany.mock.calls.findIndex((args) => {
        const data = (args[0] as { data?: { status?: string } }).data;
        return data?.status === "SENT";
      })
    ];
    const deleteOrder = mockDb.emailOutbox.delete.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(deleteOrder);
    // The outbox row is deleted after a successful send.
    expect(mockDb.emailOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
    // The raw token is never written to the outbox table.
    expect(mockDb.emailOutbox.create).not.toHaveBeenCalled();
  });

  it("silently discards an unknown email address without sending anything", async () => {
    const row = outboxRow({ email: "nobody@example.com" });
    setUpPendingRows([row]);
    mockFindUserByEmail.mockResolvedValue(null);

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 1, failed: 0, permanentlyFailed: 0 });
    expect(mockFindUserByEmail).toHaveBeenCalledWith("nobody@example.com");
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.emailOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
  });

  it("silently discards an OAuth-only address (no password) without sending anything", async () => {
    const row = outboxRow();
    setUpPendingRows([row]);
    mockFindUserByEmail.mockResolvedValue({ ...customerUser, passwordHash: null });

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 1, failed: 0, permanentlyFailed: 0 });
    expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.emailOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
  });

  it("an SMTP failure retries with backoff and keeps the row pending (never reveals the failure to the endpoint)", async () => {
    const row = outboxRow();
    setUpPendingRows([row]);
    mockSendPasswordResetEmail.mockRejectedValue(new Error("SMTP connection refused"));

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 0, failed: 1, permanentlyFailed: 0 });
    // The row stays PENDING with attempts=1 and a backoff (30s) before the
    // next attempt — the endpoint already returned 200 and never sees this.
    const update = failureUpdate();
    expect(update.where).toEqual({ id: row.id, status: "PENDING" });
    expect(update.data.attempts).toBe(1);
    expect(update.data.status).toBe("PENDING");
    expect(update.data.nextAttemptAt.getTime() - now.getTime()).toBe(30_000);
    expect(update.data.lastError).toBe("Error: SMTP connection refused");
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it("marks the row FAILED after the maximum attempts and captures an error for operators", async () => {
    const row = outboxRow({ attempts: EMAIL_OUTBOX_MAX_ATTEMPTS - 1 });
    setUpPendingRows([row]);
    mockSendPasswordResetEmail.mockRejectedValue(new Error("SMTP connection refused"));

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 0, failed: 1, permanentlyFailed: 1 });
    const update = failureUpdate();
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

  it("enqueues a password reset email as a single row carrying only the email", async () => {
    mockDb.emailOutbox.create.mockResolvedValue({ id: "outbox-new" });

    await enqueuePasswordResetEmail({ email: "customer@example.com" });

    expect(mockDb.emailOutbox.findFirst).toHaveBeenCalledWith({
      where: { type: "PASSWORD_RESET", email: "customer@example.com", status: "PENDING" },
      select: { id: true },
    });
    expect(mockDb.emailOutbox.create).toHaveBeenCalledWith({
      data: {
        type: "PASSWORD_RESET",
        email: "customer@example.com",
      },
    });
  });

  it("does not enqueue a second row while a PENDING row exists for the same type and email (M-25)", async () => {
    mockDb.emailOutbox.findFirst.mockResolvedValue({ id: "outbox-existing" });

    await enqueuePasswordResetEmail({ email: "customer@example.com" });

    expect(mockDb.emailOutbox.create).not.toHaveBeenCalled();
    expect(mockDb.emailOutbox.findFirst).toHaveBeenCalledWith({
      where: { type: "PASSWORD_RESET", email: "customer@example.com", status: "PENDING" },
      select: { id: true },
    });
  });

  it("enqueues a verification email for a different type even when a reset row is pending", async () => {
    mockDb.emailOutbox.findFirst
      .mockResolvedValueOnce(null) // no PENDING verification row
      .mockResolvedValueOnce(null);
    mockDb.emailOutbox.create.mockResolvedValue({ id: "outbox-new" });

    await enqueueVerificationEmail({ email: "customer@example.com" });

    expect(mockDb.emailOutbox.create).toHaveBeenCalledWith({
      data: { type: "EMAIL_VERIFICATION", email: "customer@example.com" },
    });
  });

  it("registers at most one worker per process and honours its own opt-out", () => {
    const registry = globalThis as Record<symbol, unknown>;
    const key = Symbol.for("khareedo.email-outbox-worker");
    const previous = process.env.EMAIL_OUTBOX_WORKER;
    const previousWorker = registry[key];
    delete registry[key];
    try {
      // Its own opt-out disables it, independent of payment maintenance.
      process.env.EMAIL_OUTBOX_WORKER = "off";
      expect(() => startEmailOutboxWorker()).not.toThrow();
      expect(registry[key]).toBeUndefined();

      process.env.EMAIL_OUTBOX_WORKER = "on";
      startEmailOutboxWorker();
      const first = registry[key];
      expect(first).toBeDefined();
      startEmailOutboxWorker();
      expect(registry[key]).toBe(first); // second call reused the registered worker
      if (first && typeof first === "object" && "stop" in first) {
        (first as { stop(): void }).stop();
      }
    } finally {
      delete registry[key];
      registry[key] = previousWorker;
      if (previous === undefined) delete process.env.EMAIL_OUTBOX_WORKER;
      else process.env.EMAIL_OUTBOX_WORKER = previous;
    }
  });

  it("its own opt-out is independent of the payment maintenance opt-out", () => {
    const registry = globalThis as Record<symbol, unknown>;
    const key = Symbol.for("khareedo.email-outbox-worker");
    const previousEmail = process.env.EMAIL_OUTBOX_WORKER;
    const previousPayment = process.env.PAYMENT_MAINTENANCE_WORKER;
    const previousWorker = registry[key];
    delete registry[key];
    try {
      // Disabling payment maintenance must NOT disable the email worker.
      process.env.PAYMENT_MAINTENANCE_WORKER = "off";
      delete process.env.EMAIL_OUTBOX_WORKER;
      startEmailOutboxWorker();
      expect(registry[key]).toBeDefined();
      const worker = registry[key];
      if (worker && typeof worker === "object" && "stop" in worker) {
        (worker as { stop(): void }).stop();
      }
    } finally {
      delete registry[key];
      registry[key] = previousWorker;
      if (previousEmail === undefined) delete process.env.EMAIL_OUTBOX_WORKER;
      else process.env.EMAIL_OUTBOX_WORKER = previousEmail;
      if (previousPayment === undefined) delete process.env.PAYMENT_MAINTENANCE_WORKER;
      else process.env.PAYMENT_MAINTENANCE_WORKER = previousPayment;
    }
  });
});

describe("email outbox verification delivery (Phase 3 Chunk 7, M-24)", () => {
  const unverifiedUser = {
    id: "user-1",
    email: "customer@example.com",
    name: "Customer",
    passwordHash: "hashed-password",
    emailVerified: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendVerificationEmail.mockResolvedValue(undefined);
    mockIsEmailDeliveryConfigured.mockReturnValue(true);
    mockDb.emailOutbox.findFirst.mockResolvedValue(null);
  });

  it("delivers a verification email: looks the account up, creates a hashed token, sends the link, deletes the row", async () => {
    const row = outboxRow({ type: "EMAIL_VERIFICATION" });
    setUpPendingRows([row]);
    mockFindUserByEmail.mockResolvedValue(unverifiedUser);

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 1, discarded: 0, failed: 0, permanentlyFailed: 0 });
    expect(mockFindUserByEmail).toHaveBeenCalledWith("customer@example.com");
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendVerificationEmail.mock.calls[0][0];
    expect(sent.email).toBe("customer@example.com");
    expect(typeof sent.token).toBe("string");
    expect(sent.token.length).toBeGreaterThan(20);
    expect(hashVerificationToken(sent.token)).toMatch(/^[a-f0-9]{64}$/);
    // The token hash is stored, never the raw token — and the link uses
    // the default destination: the outbox row carries only the email, so
    // the request's callbackUrl cannot reach the worker.
    expect(sent.callbackUrl).toBe("/account");
    expect(mockDb.emailOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
    expect(mockDb.emailOutbox.create).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown address", null],
    ["OAuth-only address (no password)", { ...unverifiedUser, passwordHash: null }],
    ["already-verified address", { ...unverifiedUser, emailVerified: new Date() }],
  ])("silently discards a %s without sending anything", async (_label, user) => {
    const row = outboxRow({ type: "EMAIL_VERIFICATION" });
    setUpPendingRows([row]);
    mockFindUserByEmail.mockResolvedValue(user);

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 1, failed: 0, permanentlyFailed: 0 });
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.emailOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
  });

  it("an SMTP failure retries a verification email with backoff like a reset", async () => {
    const row = outboxRow({ type: "EMAIL_VERIFICATION" });
    setUpPendingRows([row]);
    mockFindUserByEmail.mockResolvedValue(unverifiedUser);
    mockSendVerificationEmail.mockRejectedValue(new Error("SMTP connection refused"));

    const result = await deliverPendingOutboxEmails(10, now);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 0, failed: 1, permanentlyFailed: 0 });
    const update = failureUpdate();
    expect(update.data.attempts).toBe(1);
    expect(update.data.status).toBe("PENDING");
    expect(update.data.nextAttemptAt.getTime() - now.getTime()).toBe(30_000);
  });
});

describe("email outbox admin functions (Phase 3 Chunk 7, H-15 / M-23)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists entries with a status filter and pagination", async () => {
    const rows = [
      { id: "a", type: "PASSWORD_RESET", email: "a@example.com", status: "FAILED", attempts: 5, nextAttemptAt: now, lastError: "Error", createdAt: now },
      { id: "b", type: "EMAIL_VERIFICATION", email: "b@example.com", status: "FAILED", attempts: 5, nextAttemptAt: now, lastError: "Error", createdAt: now },
    ];
    mockDb.emailOutbox.findMany.mockResolvedValue(rows);
    mockDb.emailOutbox.count.mockResolvedValue(2);

    const result = await listEmailOutboxEntries({ status: "FAILED", page: 1, perPage: 25 });

    expect(result).toEqual({ entries: rows, total: 2, page: 1, perPage: 25 });
    expect(mockDb.emailOutbox.findMany).toHaveBeenCalledWith({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 25,
    });
    expect(mockDb.emailOutbox.count).toHaveBeenCalledWith({ where: { status: "FAILED" } });
  });

  it("ignores an unknown status filter instead of returning nothing", async () => {
    mockDb.emailOutbox.findMany.mockResolvedValue([]);
    mockDb.emailOutbox.count.mockResolvedValue(0);

    await listEmailOutboxEntries({ status: "SENT" });

    expect(mockDb.emailOutbox.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 25,
    });
  });

  it("returns one entry by id, or null", async () => {
    const row = { id: "a", type: "PASSWORD_RESET", email: "a@example.com", status: "FAILED", attempts: 5, nextAttemptAt: now, lastError: "Error", createdAt: now };
    mockDb.emailOutbox.findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce(null);

    await expect(getEmailOutboxEntry("a")).resolves.toEqual(row);
    await expect(getEmailOutboxEntry("missing")).resolves.toBeNull();
  });

  it("retries a FAILED row with a fresh attempt budget, and refuses a non-FAILED row", async () => {
    mockDb.emailOutbox.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(retryEmailOutboxEntry("failed-row", now)).resolves.toBe(true);
    expect(mockDb.emailOutbox.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "failed-row", status: "FAILED" },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lastError: null },
    });

    await expect(retryEmailOutboxEntry("pending-row", now)).resolves.toBe(false);
  });

  it("cleanup deletes only old terminal rows (FAILED/SENT past 30 days), never PENDING ones", async () => {
    mockDb.emailOutbox.deleteMany.mockResolvedValue({ count: 3 });

    const result = await cleanupEmailOutboxEntries(now);

    expect(result).toEqual({ deleted: 3 });
    const call = mockDb.emailOutbox.deleteMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ["FAILED", "SENT"] });
    expect(call.where.createdAt.lt.getTime()).toBe(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  });
});
