// Integration test — email outbox visibility + delivery reliability
// (Phase 3 Chunk 7) against a throwaway SQLite database. Run with:
// npm run test:db
//
// Covers, with the real Prisma layer:
// - M-25: two rapid reset requests for the same email enqueue one row;
//   different emails get separate rows.
// - M-24: registration with SMTP failing still succeeds and enqueues a
//   verification row; the worker delivers it on retry and the verification
//   link works end to end.
// - M-23: cleanup deletes only old terminal (FAILED/SENT) rows, never
//   PENDING ones.
// - H-15: the admin list/retry functions see FAILED rows and re-enqueue them.
//
// The disposable database is shared across integration suites in a run, so
// every assertion is scoped to this file's own unique emails and every row
// created here is cleaned up in afterAll.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

let verificationShouldFail = false;
const sentVerificationTokens: Array<{ email: string; token: string }> = [];
const sentResetTokens: string[] = [];

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

vi.mock("@/services/email.service", () => ({
  isEmailDeliveryConfigured: () => true,
  classifyEmailSendError: () => ({ kind: "transient", permanent: false, authFailure: false, reason: "Transient email delivery failure — will retry with backoff." }),
  resetEmailTransporter: vi.fn(),
  sendPasswordResetEmail: vi.fn(async ({ token }: { token: string }) => {
    sentResetTokens.push(token);
  }),
  sendVerificationEmail: vi.fn(async ({ email, token }: { email: string; token: string }) => {
    if (verificationShouldFail) throw new Error("SMTP connection refused");
    sentVerificationTokens.push({ email, token });
  }),
}));

import { db } from "@/lib/db";
import { requestPasswordReset } from "@/services/password-reset.service";
import { registerUser } from "@/services/users.service";
import { verifyEmailTokenForLogin } from "@/services/email-verification.service";
import {
  cleanupEmailOutboxEntries,
  deliverPendingOutboxEmails,
  listEmailOutboxEntries,
  retryEmailOutboxEntry,
} from "@/services/email-outbox.service";

// These tests run only through the disposable SQLite test harness. They
// exercise the real Prisma layer and never use the application's configured
// database.
assertDisposableTestDatabase();

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const resetEmail = `outbox-dedup-${suffix}@example.invalid`;
const otherResetEmail = `outbox-dedup-other-${suffix}@example.invalid`;
const verifyEmail = `outbox-verify-${suffix}@example.invalid`;
const cleanupEmailBase = `outbox-cleanup-${suffix}`;
const adminEmail = `outbox-admin-${suffix}@example.invalid`;

const createdEmails = [resetEmail, otherResetEmail, verifyEmail, adminEmail];

afterAll(async () => {
  await db.emailOutbox.deleteMany({ where: { email: { in: createdEmails } } });
  await db.emailOutbox.deleteMany({ where: { email: { startsWith: cleanupEmailBase } } });
  await db.verificationToken.deleteMany({ where: { email: verifyEmail } });
  await db.user.deleteMany({ where: { email: verifyEmail } });
  await db.$disconnect();
});

describe("email outbox dedup (M-25, integration)", () => {
  it("two rapid reset requests for the same email enqueue one row; a different email gets its own row", async () => {
    await requestPasswordReset(resetEmail);
    await requestPasswordReset(resetEmail);
    await requestPasswordReset(otherResetEmail);

    const rows = await db.emailOutbox.findMany({ where: { email: resetEmail } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("PASSWORD_RESET");
    expect(rows[0].status).toBe("PENDING");

    const otherRows = await db.emailOutbox.findMany({ where: { email: otherResetEmail } });
    expect(otherRows).toHaveLength(1);

    // Clean up so later delivery assertions in other suites are unaffected.
    await db.emailOutbox.deleteMany({ where: { email: { in: [resetEmail, otherResetEmail] } } });
  });
});

describe("verification mail via the outbox (M-24, integration)", () => {
  it("registration succeeds while SMTP is down, and the worker delivers the verification email on retry", async () => {
    // SMTP is down: registration must still succeed — it only enqueues.
    verificationShouldFail = true;
    const result = await registerUser({
      name: "Outbox Verify",
      email: verifyEmail,
      password: "a-strong-password",
    });
    expect(result).toEqual({ ok: true });

    const rows = await db.emailOutbox.findMany({ where: { email: verifyEmail } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("EMAIL_VERIFICATION");
    expect(rows[0].status).toBe("PENDING");
    // No token exists yet and no email was sent — the worker creates the
    // token at delivery time.
    expect(sentVerificationTokens.filter((s) => s.email === verifyEmail)).toHaveLength(0);
    expect(await db.verificationToken.count({ where: { email: verifyEmail } })).toBe(0);

    // The worker sweep runs while SMTP is still down: the row stays
    // PENDING with a recorded failure, and registration already succeeded.
    const failedDelivery = await deliverPendingOutboxEmails(10);
    expect(failedDelivery.failed).toBeGreaterThanOrEqual(1);
    const stillPending = await db.emailOutbox.findMany({ where: { email: verifyEmail } });
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].status).toBe("PENDING");
    expect(stillPending[0].attempts).toBe(1);
    // lastError carries the full message (Phase 3, chunk 12 follow-up B):
    // it used to store only the error name ("Error"), which told the
    // admin nothing about the failure.
    expect(stillPending[0].lastError).toContain("SMTP connection refused");

    // SMTP recovers: the next sweep delivers the email and the stored
    // token verifies the account end to end. (The failed attempt set a 30s
    // backoff, so the test moves nextAttemptAt into the past to simulate
    // the backoff elapsing — it does not wait 30 real seconds.)
    verificationShouldFail = false;
    await db.emailOutbox.updateMany({
      where: { email: verifyEmail },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const delivery = await deliverPendingOutboxEmails(10);
    expect(delivery.delivered).toBeGreaterThanOrEqual(1);
    const sent = sentVerificationTokens.find((s) => s.email === verifyEmail);
    expect(sent).toBeDefined();
    expect(await db.emailOutbox.count({ where: { email: verifyEmail } })).toBe(0);

    const verified = await verifyEmailTokenForLogin(sent!.token);
    expect(verified).not.toBeNull();
    expect(verified!.email).toBe(verifyEmail);
    const user = await db.user.findUnique({ where: { email: verifyEmail } });
    expect(user!.emailVerified).not.toBeNull();
  });
});

describe("outbox retention cleanup (M-23, integration)", () => {
  it("deletes only old terminal rows, never PENDING ones", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const seed = async (email: string, status: string, createdAt: Date) =>
      db.emailOutbox.create({ data: { type: "PASSWORD_RESET", email, status, createdAt } });
    await seed(`${cleanupEmailBase}-old-failed@example.invalid`, "FAILED", old);
    await seed(`${cleanupEmailBase}-recent-failed@example.invalid`, "FAILED", recent);
    await seed(`${cleanupEmailBase}-old-pending@example.invalid`, "PENDING", old);
    await seed(`${cleanupEmailBase}-old-sent@example.invalid`, "SENT", old);

    const result = await cleanupEmailOutboxEntries();

    expect(result.deleted).toBe(2);
    expect(await db.emailOutbox.count({ where: { email: `${cleanupEmailBase}-old-failed@example.invalid` } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { email: `${cleanupEmailBase}-old-sent@example.invalid` } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { email: `${cleanupEmailBase}-recent-failed@example.invalid` } })).toBe(1);
    expect(await db.emailOutbox.count({ where: { email: `${cleanupEmailBase}-old-pending@example.invalid` } })).toBe(1);

    await db.emailOutbox.deleteMany({ where: { email: { startsWith: cleanupEmailBase } } });
  });
});

describe("admin outbox visibility and retry (H-15, integration)", () => {
  it("lists FAILED rows with their error and retries one back to PENDING", async () => {
    await db.emailOutbox.create({
      data: {
        type: "PASSWORD_RESET",
        email: adminEmail,
        status: "FAILED",
        attempts: 5,
        lastError: "Error",
      },
    });

    const listed = await listEmailOutboxEntries({ status: "FAILED", page: 1, perPage: 25 });
    const entry = listed.entries.find((e) => e.email === adminEmail);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("FAILED");
    expect(entry!.attempts).toBe(5);
    expect(entry!.lastError).toBe("Error");

    await expect(retryEmailOutboxEntry(entry!.id)).resolves.toBe(true);
    const retried = await db.emailOutbox.findUnique({ where: { id: entry!.id } });
    expect(retried!.status).toBe("PENDING");
    expect(retried!.attempts).toBe(0);
    expect(retried!.lastError).toBeNull();

    // A second retry refuses: the row is no longer FAILED.
    await expect(retryEmailOutboxEntry(entry!.id)).resolves.toBe(false);

    await db.emailOutbox.deleteMany({ where: { email: adminEmail } });
  });
});
