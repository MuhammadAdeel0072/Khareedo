// Unit tests — email outbox delivery reliability (email-outbox reliability
// stream). A small in-memory fake stands in for Prisma so crash and lease
// scenarios can be simulated exactly: a delete that throws mid-delivery, a
// SENT mark that throws, an unexpired claim lease, a reclaimed expired
// lease. The REAL classifyEmailSendError is used (imported from the real
// email.service module); only the send functions and the config check are
// mocked. No real email is sent and no real SMTP is involved.
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeRow = {
  id: string;
  type: string;
  email: string;
  payload: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function matchesWhere(row: FakeRow, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === "id" && row.id !== value) return false;
    if (key === "email" && row.email !== value) return false;
    if (key === "type" && row.type !== value) return false;
    if (key === "status") {
      if (typeof value === "string" && row.status !== value) return false;
      if (value && typeof value === "object" && "in" in (value as Record<string, unknown>)) {
        const list = (value as { in: string[] }).in;
        if (!list.includes(row.status)) return false;
      }
    }
    if (key === "nextAttemptAt" && value && typeof value === "object" && "lte" in (value as Record<string, unknown>)) {
      if (row.nextAttemptAt > (value as { lte: Date }).lte) return false;
    }
    if (key === "createdAt" && value && typeof value === "object" && "lt" in (value as Record<string, unknown>)) {
      if (row.createdAt >= (value as { lt: Date }).lt) return false;
    }
    if (key === "payload" && row.payload !== value) return false;
  }
  return true;
}

const state = vi.hoisted(() => {
  const rows: FakeRow[] = [];
  const ops: string[] = [];
  const createdTokenHashes: string[] = [];
  const hooks = {
    rows,
    ops,
    createdTokenHashes,
    idSeq: 0,
    configured: true,
    configError: null as Error | null,
    sendImpl: (async () => {}) as () => Promise<void>,
    failDeleteOnce: false,
    failSentMarkOnce: false,
    mockIsEmailDeliveryConfigured: vi.fn(() => {
      if (hooks.configError) throw hooks.configError;
      return hooks.configured;
    }),
    mockResetEmailTransporter: vi.fn(),
    mockCaptureError: vi.fn(),
    mockCapturePaymentAlert: vi.fn(),
    mockFindUserByEmail: vi.fn(),
  };
  const recordSend = () => {
    hooks.ops.push("send");
    return hooks.sendImpl();
  };
  const fakeDb = {
    emailOutbox: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        const found = hooks.rows
          .filter((row) => matchesWhere(row, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return typeof take === "number" ? found.slice(0, take) : found;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const found = hooks.rows.find((row) => matchesWhere(row, where));
        return found ? { id: found.id } : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return hooks.rows.find((row) => row.id === where.id) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return hooks.rows.filter((row) => matchesWhere(row, where)).length;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: FakeRow = {
          id: `row-${++hooks.idSeq}`,
          type: data.type as string,
          email: data.email as string,
          payload: (data.payload as string | null) ?? null,
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        hooks.rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (hooks.failSentMarkOnce && data?.status === "SENT") {
          hooks.failSentMarkOnce = false;
          throw new Error("simulated crash: SENT mark failed");
        }
        const matched = hooks.rows.filter((row) => matchesWhere(row, where));
        for (const row of matched) Object.assign(row, data, { updatedAt: new Date() });
        // Only a matched update has an effect — a conditional update that
        // matches nothing (e.g. the failure-path update for a row already
        // marked SENT) records no op.
        if (matched.length > 0) {
          if (data?.status === "SENT") hooks.ops.push("markSENT");
          else if (typeof data?.attempts === "number") hooks.ops.push("fail-update");
          else if (data?.nextAttemptAt) hooks.ops.push("claim");
        }
        return { count: matched.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = hooks.rows.find((r) => r.id === where.id);
        if (!row) throw new Error("Record to update does not exist.");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = hooks.rows.findIndex((row) => row.id === where.id);
        if (index === -1) throw new Error("Record to delete does not exist.");
        if (hooks.failDeleteOnce) {
          hooks.failDeleteOnce = false;
          throw new Error("simulated crash: delete failed");
        }
        const [removed] = hooks.rows.splice(index, 1);
        hooks.ops.push("delete");
        return removed;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = hooks.rows.length;
        for (let i = hooks.rows.length - 1; i >= 0; i--) {
          if (matchesWhere(hooks.rows[i], where)) hooks.rows.splice(i, 1);
        }
        return { count: before - hooks.rows.length };
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
      const tx = {
        passwordResetToken: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => {
            hooks.createdTokenHashes.push(data.tokenHash);
            return { id: "tok-1", ...data };
          }),
        },
        verificationToken: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => {
            hooks.createdTokenHashes.push(data.tokenHash);
            return { id: "tok-1", ...data };
          }),
        },
      };
      return callback(tx);
    }),
  };
  // Return the SAME hooks object (not a spread copy): the fake db methods
  // and the send/config mocks close over `hooks`, and the tests mutate the
  // flags through the returned object — a spread would copy the primitives
  // by value and the mutations would never reach the closures.
  const state = hooks as typeof hooks & {
    fakeDb: typeof fakeDb;
    recordSend: typeof recordSend;
  };
  state.fakeDb = fakeDb;
  state.recordSend = recordSend;
  return state;
});

vi.mock("@/lib/db", () => ({ db: state.fakeDb }));
vi.mock("@/services/email.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/email.service")>();
  const sendMock = () => vi.fn(async () => state.recordSend());
  return {
    ...actual,
    isEmailDeliveryConfigured: state.mockIsEmailDeliveryConfigured,
    resetEmailTransporter: state.mockResetEmailTransporter,
    sendPasswordResetEmail: sendMock(),
    sendVerificationEmail: sendMock(),
    sendOrderConfirmedEmail: sendMock(),
    sendOrderStatusEmail: sendMock(),
    sendOrderCancelledEmail: sendMock(),
    sendOrderPaymentSucceededEmail: sendMock(),
    sendOrderPaymentFailedEmail: sendMock(),
    sendOrderRefundSucceededEmail: sendMock(),
  };
});
vi.mock("@/lib/error-monitoring", () => ({
  captureError: state.mockCaptureError,
  capturePaymentAlert: state.mockCapturePaymentAlert,
}));
vi.mock("@/services/auth-users.service", () => ({
  findUserByEmail: state.mockFindUserByEmail,
}));
vi.mock("@/services/password-reset.service", () => ({
  PASSWORD_RESET_TOKEN_TTL_MS: 60 * 60 * 1000,
  hashPasswordResetToken: (token: string) => `hash-${token}`,
}));
vi.mock("@/services/email-verification.service", () => ({
  VERIFICATION_TOKEN_TTL_MS: 24 * 60 * 60 * 1000,
  hashVerificationToken: (token: string) => `hash-${token}`,
}));
vi.mock("@/services/worker-heartbeat", () => ({
  recordOutboxSweepFailed: vi.fn(),
  recordOutboxSweepStarted: vi.fn(),
  recordOutboxSweepSucceeded: vi.fn(),
  recordOutboxWorkerStarted: vi.fn(),
  recordOutboxWorkerStopped: vi.fn(),
}));

import {
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  deliverPendingOutboxEmails,
  enqueuePasswordResetEmail,
  retryEmailOutboxEntry,
} from "@/services/email-outbox.service";

const T0 = new Date("2026-11-19T12:00:00Z");
const CUSTOMER = {
  id: "user-1",
  email: "customer@example.com",
  name: "Customer",
  passwordHash: "hashed-password",
};

function seedRow(overrides: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    id: `row-${++state.idSeq}`,
    type: "PASSWORD_RESET",
    email: "customer@example.com",
    payload: null,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: new Date(T0.getTime() - 1_000),
    lastError: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...overrides,
  };
  state.rows.push(row);
  return row;
}

function authError(message = "535 5.7.8 Authentication Credentials Invalid"): Error {
  const error = new Error(message);
  (error as unknown as Record<string, unknown>).code = "EAUTH";
  (error as unknown as Record<string, unknown>).responseCode = 535;
  return error;
}

function envelopeError(message = "550 5.1.1 Mailbox unavailable"): Error {
  const error = new Error(message);
  (error as unknown as Record<string, unknown>).code = "EENVELOPE";
  (error as unknown as Record<string, unknown>).responseCode = 550;
  return error;
}

describe("email outbox delivery reliability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
    state.ops.length = 0;
    state.createdTokenHashes.length = 0;
    state.configured = true;
    state.configError = null;
    state.sendImpl = async () => {};
    state.failDeleteOnce = false;
    state.failSentMarkOnce = false;
    state.mockFindUserByEmail.mockResolvedValue(CUSTOMER);
  });

  it("(i) successful delivery marks the row SENT before deleting it, counts delivered, stores only a token hash", async () => {
    const row = seedRow();

    const result = await deliverPendingOutboxEmails(10, T0);

    expect(result).toEqual({ considered: 1, delivered: 1, discarded: 0, failed: 0, permanentlyFailed: 0 });
    expect(state.ops).toEqual(["claim", "send", "markSENT", "delete"]);
    expect(state.rows.find((r) => r.id === row.id)).toBeUndefined();
    // One token hash was stored (the stub hash is "hash-<token>"; the real
    // SHA-256-only-storage property is covered by email-outbox.test.ts
    // with the real hash functions).
    expect(state.createdTokenHashes).toHaveLength(1);
  });

  it("(i) an order notification is also marked SENT before delete", async () => {
    seedRow({
      type: "ORDER_CONFIRMED",
      payload: JSON.stringify({
        orderId: "ord-1",
        reference: "KH261120000001",
        customerName: "Buyer",
        total: 2000,
        paymentMethod: "COD",
        status: "CONFIRMED",
        refundAmountMinor: "0",
      }),
    });

    const result = await deliverPendingOutboxEmails(10, T0);

    expect(result.delivered).toBe(1);
    expect(state.ops).toEqual(["claim", "send", "markSENT", "delete"]);
    expect(state.rows).toHaveLength(0);
  });

  it("(ii) a transient failure retries with backoff, and the backoff window is respected", async () => {
    const row = seedRow();
    let calls = 0;
    state.sendImpl = async () => {
      calls += 1;
      if (calls === 1) throw new Error("SMTP connection refused");
    };

    const first = await deliverPendingOutboxEmails(10, T0);
    expect(first).toEqual({ considered: 1, delivered: 0, discarded: 0, failed: 1, permanentlyFailed: 0 });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime() - T0.getTime()).toBe(30_000);
    expect(row.lastError).toBe("Error: SMTP connection refused");

    // Inside the 30s backoff the row is not due: a second sweep ignores it.
    const duringBackoff = await deliverPendingOutboxEmails(10, new Date(T0.getTime() + 10_000));
    expect(duringBackoff.considered).toBe(0);
    expect(calls).toBe(1);

    // After the backoff elapses the retry delivers it.
    const afterBackoff = await deliverPendingOutboxEmails(10, new Date(T0.getTime() + 31_000));
    expect(afterBackoff.delivered).toBe(1);
    expect(calls).toBe(2);
    expect(state.rows).toHaveLength(0);
  });

  it("(iii) unconfigured SMTP fails rows FAILED immediately — no send, no retries, one monitoring event per sweep", async () => {
    state.configured = false;
    seedRow();
    seedRow({ id: "row-other", email: "other@example.com" });

    const result = await deliverPendingOutboxEmails(10, T0);

    expect(result).toEqual({ considered: 2, delivered: 0, discarded: 0, failed: 2, permanentlyFailed: 2 });
    expect(state.ops).not.toContain("send");
    for (const row of state.rows) {
      expect(row.status).toBe("FAILED");
      expect(row.attempts).toBe(EMAIL_OUTBOX_MAX_ATTEMPTS);
      expect(row.lastError).toMatch(/not configured/i);
      expect(row.lastError).toContain("SMTP_HOST");
    }
    // One event for the whole sweep, not one per row.
    expect(state.mockCaptureError).toHaveBeenCalledTimes(1);

    // A FAILED row is never retried automatically.
    const again = await deliverPendingOutboxEmails(10, T0);
    expect(again.considered).toBe(0);
  });

  it("(iii) a half-configured SMTP_USER/SMTP_PASSWORD pair also fails fast", async () => {
    state.configError = new Error("SMTP_USER and SMTP_PASSWORD must both be configured.");
    const row = seedRow();

    const result = await deliverPendingOutboxEmails(10, T0);

    expect(result.permanentlyFailed).toBe(1);
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("SMTP_USER and SMTP_PASSWORD must both be configured.");
    expect(state.ops).not.toContain("send");
  });

  it("(iii) an SMTP auth failure goes FAILED immediately, resets the transporter, and is never retried", async () => {
    const row = seedRow();
    state.sendImpl = async () => {
      throw authError();
    };

    const result = await deliverPendingOutboxEmails(10, T0);

    expect(result).toEqual({ considered: 1, delivered: 0, discarded: 0, failed: 1, permanentlyFailed: 1 });
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(EMAIL_OUTBOX_MAX_ATTEMPTS);
    expect(row.lastError).toMatch(/authentication failed/i);
    expect(state.mockResetEmailTransporter).toHaveBeenCalledTimes(1);
    expect(state.mockCaptureError).toHaveBeenCalledTimes(1);

    // No second attempt: the row is FAILED, not PENDING.
    const again = await deliverPendingOutboxEmails(10, new Date(T0.getTime() + 60_000));
    expect(again.considered).toBe(0);
    expect(state.mockResetEmailTransporter).toHaveBeenCalledTimes(1);
  });

  it("(iv) an invalid recipient (EENVELOPE / 550) goes FAILED immediately without resetting the transporter", async () => {
    const row = seedRow();
    state.sendImpl = async () => {
      throw envelopeError();
    };

    const result = await deliverPendingOutboxEmails(10, T0);

    expect(result.permanentlyFailed).toBe(1);
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(EMAIL_OUTBOX_MAX_ATTEMPTS);
    expect(row.lastError).toMatch(/recipient/i);
    expect(state.mockResetEmailTransporter).not.toHaveBeenCalled();
  });

  it("(v) a crash between the SENT mark and the delete does NOT re-send: the row stays SENT and the next sweep ignores it", async () => {
    const row = seedRow();
    state.failDeleteOnce = true;

    const first = await deliverPendingOutboxEmails(10, T0);
    // The delete threw, so the sweep counts a failure — but the email was
    // sent exactly once and the row is SENT, never to be swept again.
    expect(first.considered).toBe(1);
    expect(first.failed).toBe(1);
    expect(state.ops).toEqual(["claim", "send", "markSENT"]);
    expect(row.status).toBe("SENT");
    expect(row.attempts).toBe(0);

    const second = await deliverPendingOutboxEmails(10, new Date(T0.getTime() + 60_000));
    expect(second.considered).toBe(0);
    expect(state.ops.filter((op) => op === "send")).toHaveLength(1);
  });

  it("(v, residual window) a crash between sendMail succeeding and the SENT mark landing still re-sends — documented at-least-once window", async () => {
    seedRow();
    state.failSentMarkOnce = true;
    let sends = 0;
    const countingImpl = state.sendImpl;
    state.sendImpl = async () => {
      sends += 1;
      await countingImpl();
    };

    const first = await deliverPendingOutboxEmails(10, T0);
    expect(first.failed).toBe(1);
    expect(sends).toBe(1);
    // The mark threw, so the row is still PENDING with a backoff: the
    // next sweep after the backoff re-sends. This is the one-DB-round-trip
    // window the SENT mark cannot close without a provider idempotency
    // key; the token is regenerated, so only the latest token is usable.
    const second = await deliverPendingOutboxEmails(10, new Date(T0.getTime() + 31_000));
    expect(second.delivered).toBe(1);
    expect(sends).toBe(2);
  });

  it("(vi) restart recovery: an unexpired claim lease is respected, an expired lease is reclaimed", async () => {
    // As if another worker claimed the row and crashed: nextAttemptAt is
    // the lease expiry, 5 minutes out.
    const row = seedRow({ nextAttemptAt: new Date(T0.getTime() + 5 * 60_000) });

    const duringLease = await deliverPendingOutboxEmails(10, T0);
    expect(duringLease.considered).toBe(0);
    expect(state.ops).not.toContain("send");

    const afterLease = await deliverPendingOutboxEmails(10, new Date(T0.getTime() + 5 * 60_000 + 1_000));
    expect(afterLease.delivered).toBe(1);
    expect(state.rows.find((r) => r.id === row.id)).toBeUndefined();
  });

  it("(vii) the retry endpoint resets a FAILED row to PENDING with a fresh budget, and refuses a second retry", async () => {
    const row = seedRow({
      status: "FAILED",
      attempts: EMAIL_OUTBOX_MAX_ATTEMPTS,
      lastError: "Error: SMTP connection refused",
    });

    await expect(retryEmailOutboxEntry(row.id, T0)).resolves.toBe(true);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.nextAttemptAt.getTime()).toBe(T0.getTime());

    await expect(retryEmailOutboxEntry(row.id, T0)).resolves.toBe(false);

    // The retried row delivers on the next sweep.
    const result = await deliverPendingOutboxEmails(10, T0);
    expect(result.delivered).toBe(1);
  });

  it("enqueue dedup: two sequential enqueues for the same type+email create one row", async () => {
    await enqueuePasswordResetEmail({ email: "customer@example.com" });
    await enqueuePasswordResetEmail({ email: "customer@example.com" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].type).toBe("PASSWORD_RESET");
    // A different email gets its own row.
    await enqueuePasswordResetEmail({ email: "other@example.com" });
    expect(state.rows).toHaveLength(2);
  });
});
