// Email outbox worker heartbeat (Stream F).
//
// The outbox worker had no heartbeat: a dead delivery loop left rows
// PENDING (never FAILED), so neither GET /api/health nor the admin
// Operations card could see it. These tests prove the new heartbeat —
// same state machine and same 180 s stale threshold as the payment
// worker (both sweep every 60 s) — and that the real worker records it:
// a successful sweep (even an empty one, or one whose rows fail with
// backoff) is healthy; a sweep whose delivery loop itself throws is
// failing and raises the WORKER_FAILURE alert.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDb,
  mockSendPasswordResetEmail,
  mockSendVerificationEmail,
  mockCaptureError,
  mockCapturePaymentAlert,
  mockFindUserByEmail,
} = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/services/email.service", () => ({
  isEmailDeliveryConfigured: () => true,
  classifyEmailSendError: () => ({ kind: "transient", permanent: false, authFailure: false, reason: "Transient email delivery failure — will retry with backoff." }),
  resetEmailTransporter: vi.fn(),
  sendPasswordResetEmail: mockSendPasswordResetEmail,
  sendVerificationEmail: mockSendVerificationEmail,
  sendOrderCancelledEmail: vi.fn(),
  sendOrderConfirmedEmail: vi.fn(),
  sendOrderPaymentFailedEmail: vi.fn(),
  sendOrderPaymentSucceededEmail: vi.fn(),
  sendOrderRefundSucceededEmail: vi.fn(),
  sendOrderStatusEmail: vi.fn(),
}));
vi.mock("@/lib/error-monitoring", () => ({
  captureError: mockCaptureError,
  capturePaymentAlert: mockCapturePaymentAlert,
}));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: mockFindUserByEmail,
}));

import {
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  getOutboxWorkerHeartbeat,
  getWorkerHeartbeat,
  recordOutboxSweepFailed,
  recordOutboxSweepStarted,
  recordOutboxSweepSucceeded,
  recordOutboxWorkerStarted,
  recordOutboxWorkerStopped,
  recordSweepSucceeded,
  recordWorkerStarted,
  resetOutboxWorkerHeartbeat,
  resetWorkerHeartbeat,
} from "@/services/worker-heartbeat";
import { createEmailOutboxWorker } from "@/services/email-outbox.service";

const T0 = 1_780_000_000_000; // fixed base time, keeps the tests deterministic

describe("outbox worker heartbeat", () => {
  beforeEach(() => {
    resetOutboxWorkerHeartbeat();
    resetWorkerHeartbeat();
  });

  it("starts as not_started with empty timestamps", () => {
    const heartbeat = getOutboxWorkerHeartbeat(T0);
    expect(heartbeat.status).toBe("not_started");
    expect(heartbeat.startedAt).toBeNull();
    expect(heartbeat.lastSuccessAt).toBeNull();
    expect(heartbeat.lastFailureAt).toBeNull();
    expect(heartbeat.ageMs).toBeNull();
    expect(heartbeat.consecutiveFailures).toBe(0);
    expect(heartbeat.staleAfterMs).toBe(WORKER_HEARTBEAT_STALE_AFTER_MS);
  });

  it("is healthy after a successful sweep, with ISO timestamps", () => {
    recordOutboxWorkerStarted(T0);
    recordOutboxSweepStarted(T0);
    recordOutboxSweepSucceeded(T0 + 500);
    const heartbeat = getOutboxWorkerHeartbeat(T0 + 1_000);
    expect(heartbeat.status).toBe("healthy");
    expect(heartbeat.startedAt).toBe(new Date(T0).toISOString());
    expect(heartbeat.lastSuccessAt).toBe(new Date(T0 + 500).toISOString());
    expect(heartbeat.ageMs).toBe(500);
    expect(heartbeat.sweepsCompleted).toBe(1);
    expect(heartbeat.consecutiveFailures).toBe(0);
  });

  it("is healthy inside the first-sweep window before any sweep completes", () => {
    recordOutboxWorkerStarted(T0);
    expect(getOutboxWorkerHeartbeat(T0 + 60_000).status).toBe("healthy");
  });

  it("turns stale when no sweep succeeds within the stale window", () => {
    recordOutboxWorkerStarted(T0);
    recordOutboxSweepSucceeded(T0);
    expect(getOutboxWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS).status).toBe("healthy");
    expect(getOutboxWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS + 1).status).toBe("stale");
    const heartbeat = getOutboxWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS + 1);
    expect(heartbeat.ageMs).toBe(WORKER_HEARTBEAT_STALE_AFTER_MS + 1);
  });

  it("turns stale when started but no sweep ever completes", () => {
    recordOutboxWorkerStarted(T0);
    expect(getOutboxWorkerHeartbeat(T0 + WORKER_HEARTBEAT_STALE_AFTER_MS + 1).status).toBe("stale");
  });

  it("reports failing after a failed sweep and recovers on the next success", () => {
    recordOutboxWorkerStarted(T0);
    recordOutboxSweepSucceeded(T0);
    recordOutboxSweepFailed("SWEEP_FAILED", T0 + 60_000);
    const failing = getOutboxWorkerHeartbeat(T0 + 60_000);
    expect(failing.status).toBe("failing");
    expect(failing.consecutiveFailures).toBe(1);
    expect(failing.sweepsFailed).toBe(1);
    expect(failing.lastFailureCode).toBe("SWEEP_FAILED");
    expect(failing.lastFailureAt).toBe(new Date(T0 + 60_000).toISOString());

    recordOutboxSweepFailed("SWEEP_FAILED", T0 + 120_000);
    expect(getOutboxWorkerHeartbeat(T0 + 120_000).consecutiveFailures).toBe(2);

    recordOutboxSweepSucceeded(T0 + 180_000);
    const recovered = getOutboxWorkerHeartbeat(T0 + 180_000);
    expect(recovered.status).toBe("healthy");
    expect(recovered.consecutiveFailures).toBe(0);
  });

  it("never stores free-form failure text, only a generic code", () => {
    recordOutboxWorkerStarted(T0);
    recordOutboxSweepFailed("connection to smtp://user:secret@host failed\nError: boom", T0);
    const heartbeat = getOutboxWorkerHeartbeat(T0);
    expect(heartbeat.lastFailureCode).toBe("SWEEP_FAILED");
    expect(JSON.stringify(heartbeat)).not.toContain("secret");
    expect(JSON.stringify(heartbeat)).not.toContain("boom");
  });

  it("reports stopped after the worker stops", () => {
    recordOutboxWorkerStarted(T0);
    recordOutboxSweepSucceeded(T0);
    recordOutboxWorkerStopped(T0 + 1_000);
    expect(getOutboxWorkerHeartbeat(T0 + 1_000).status).toBe("stopped");
  });

  it("is independent of the payment worker heartbeat in both directions", () => {
    recordWorkerStarted(T0);
    recordSweepSucceeded(T0);
    recordOutboxWorkerStarted(T0);
    recordOutboxSweepSucceeded(T0);

    // The outbox worker fails: only its heartbeat changes.
    recordOutboxSweepFailed("SWEEP_FAILED", T0 + 60_000);
    expect(getOutboxWorkerHeartbeat(T0 + 60_000).status).toBe("failing");
    expect(getWorkerHeartbeat(T0 + 60_000).status).toBe("healthy");

    // Resetting one heartbeat never touches the other.
    resetOutboxWorkerHeartbeat();
    expect(getOutboxWorkerHeartbeat(T0 + 60_000).status).toBe("not_started");
    expect(getWorkerHeartbeat(T0 + 60_000).status).toBe("healthy");
  });
});

describe("outbox worker records its heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOutboxWorkerHeartbeat();
    mockDb.emailOutbox.findMany.mockResolvedValue([]);
  });

  it("a successful sweep (even an empty one) marks the worker healthy", async () => {
    const worker = createEmailOutboxWorker({ log: () => {} });
    await worker.sweepOnce();
    const heartbeat = getOutboxWorkerHeartbeat();
    expect(heartbeat.status).toBe("healthy");
    expect(heartbeat.sweepsCompleted).toBe(1);
    expect(heartbeat.lastSuccessAt).not.toBeNull();
    expect(mockCapturePaymentAlert).not.toHaveBeenCalled();
  });

  it("a sweep whose delivery loop throws marks the worker failing and alerts WORKER_FAILURE", async () => {
    mockDb.emailOutbox.findMany.mockRejectedValue(new Error("database down"));
    const worker = createEmailOutboxWorker({ log: () => {} });
    await expect(worker.sweepOnce()).resolves.toBeUndefined();
    const heartbeat = getOutboxWorkerHeartbeat();
    expect(heartbeat.status).toBe("failing");
    expect(heartbeat.consecutiveFailures).toBe(1);
    expect(heartbeat.sweepsFailed).toBe(1);
    expect(heartbeat.lastFailureCode).toBe("SWEEP_FAILED");
    expect(mockCaptureError).toHaveBeenCalledWith(expect.any(Error), {
      operation: "email-outbox-sweep",
    });
    // Distinct alert code from the payment worker's SWEEP_FAILED: the
    // alert throttle is keyed on kind+code, so sharing the code would let
    // a payment-worker alert suppress this one inside the 15-minute window.
    expect(mockCapturePaymentAlert).toHaveBeenCalledTimes(1);
    expect(mockCapturePaymentAlert).toHaveBeenCalledWith("WORKER_FAILURE", {
      operation: "email-outbox-sweep",
      code: "OUTBOX_SWEEP_FAILED",
    });
  });

  it("a sweep whose rows fail with backoff still counts as a success", async () => {
    // One due row whose SMTP send fails: the delivery loop retries it with
    // backoff (attempts 0 -> 1, stays PENDING) and the sweep itself ran.
    const row = {
      id: "outbox-1",
      type: "PASSWORD_RESET",
      email: "customer@example.com",
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: new Date("2026-11-19T11:59:59.000Z"),
      lastError: null,
    };
    mockDb.emailOutbox.findMany.mockResolvedValue([row]);
    mockDb.emailOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockDb.emailOutbox.update.mockResolvedValue({ id: "updated" });
    mockFindUserByEmail.mockResolvedValue({
      id: "user-1",
      email: "customer@example.com",
      name: "Customer",
      passwordHash: "hashed-password",
    });
    mockDb.$transaction.mockImplementation(async (callback: (t: unknown) => unknown) => {
      const transaction = {
        passwordResetToken: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => ({ id: "reset-1", ...data })),
        },
      };
      return callback(transaction);
    });
    mockSendPasswordResetEmail.mockRejectedValue(new Error("SMTP connection refused"));

    const worker = createEmailOutboxWorker({ log: () => {} });
    await worker.sweepOnce();

    // The row failed and stays PENDING for retry — but the worker ran, so
    // the heartbeat is healthy and no worker alert fired. Per-row failure
    // is visible in the outbox viewer, not in the heartbeat.
    const heartbeat = getOutboxWorkerHeartbeat();
    expect(heartbeat.status).toBe("healthy");
    expect(heartbeat.sweepsFailed).toBe(0);
    expect(mockCapturePaymentAlert).not.toHaveBeenCalled();
  });

  it("records worker start and stop through the worker lifecycle", () => {
    const worker = createEmailOutboxWorker({ log: () => {} });
    worker.start();
    expect(getOutboxWorkerHeartbeat().status).not.toBe("not_started");
    worker.stop();
    expect(getOutboxWorkerHeartbeat().status).toBe("stopped");
  });
});
