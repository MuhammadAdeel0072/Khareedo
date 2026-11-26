// Integration test — admin MFA break-glass reset against a throwaway
// SQLite database (PR-10 pattern). Run with: npm run test:db
//
// Exercises the same resetAdminMfa function the operator script uses,
// against the real Prisma layer: a dry run writes nothing; the real reset
// deletes the AdminMfa row (recovery codes cascade), leaves the admin
// User row untouched, records one admin.mfa.reset audit row, and leaves
// the admin unenrolled so the next sign-in requires a fresh enrollment.
// Refusals (no enrollment, non-admin) write nothing.
//
// The reset itself is database-agnostic (it takes its client as an
// argument); the Supabase-only target guard is tested at unit level in
// tests/unit/admin-mfa-reset.test.ts, because test:db is SQLite-only by
// design and must never touch Supabase.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";
import { totpCodeForStep, totpTimeStep } from "@/lib/totp";

const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

import { db } from "@/lib/db";
import {
  activateAdminMfa,
  getAdminMfaStatus,
  startAdminMfaEnrollment,
} from "@/services/admin-mfa.service";
import { resetAdminMfa, type MfaResetStore } from "@/lib/admin-mfa-reset";

// These tests run only through the disposable SQLite test harness. They
// exercise the real Prisma layer and never use the application's configured
// database.
assertDisposableTestDatabase();

const ADMIN_PASSWORD = "admin-mfa-reset-test-password";
let adminId = "";
let adminEmail = "";

beforeAll(async () => {
  process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  adminEmail = `mfa-reset-admin-${suffix}@example.invalid`;
  const admin = await db.user.create({
    data: {
      email: adminEmail,
      name: "MFA Reset Admin",
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
      emailVerified: new Date(),
      role: "ADMIN",
    },
  });
  adminId = admin.id;
  // Enroll and activate so the admin has an enabled MFA row with 10 codes.
  const enrollment = await startAdminMfaEnrollment({ userId: adminId, email: adminEmail });
  const firstCode = totpCodeForStep(enrollment.manualKey, totpTimeStep());
  const codes = await activateAdminMfa({ userId: adminId, code: firstCode, sessionSid: randomUUID() });
  expect(codes).toHaveLength(10);
  const status = await getAdminMfaStatus(adminId);
  expect(status.enabled).toBe(true);
});

afterAll(async () => {
  await db.adminAuditLog.deleteMany({ where: { targetId: adminId } });
  await db.adminMfaRecoveryCode.deleteMany({ where: { mfa: { userId: adminId } } });
  await db.adminMfa.deleteMany({ where: { userId: adminId } });
  await db.user.deleteMany({ where: { id: adminId } });
  await db.$disconnect();
});

describe("admin MFA break-glass reset (integration)", () => {
  it("dry-run reports the reset and writes nothing", async () => {
    const result = await resetAdminMfa({
      store: db as unknown as MfaResetStore,
      email: adminEmail,
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    if (result.status !== "dry-run") return;
    expect(result.email).toBe(adminEmail);
    expect(result.userId).toBe(adminId);
    expect(result.recoveryCodesTotal).toBe(10);
    expect(result.recoveryCodesUnused).toBe(10);
    // Nothing was written: the enrollment and its codes are still there.
    const status = await getAdminMfaStatus(adminId);
    expect(status.enabled).toBe(true);
    expect(status.unusedRecoveryCodes).toBe(10);
    expect(await db.adminAuditLog.count({ where: { targetId: adminId } })).toBe(0);
  });

  it("reset deletes the MFA row and its codes, keeps the user, and audits", async () => {
    const result = await resetAdminMfa({
      store: db as unknown as MfaResetStore,
      email: adminEmail,
      dryRun: false,
    });
    expect(result).toEqual({
      status: "reset",
      email: adminEmail,
      userId: adminId,
      mfaId: expect.any(String),
      recoveryCodesDeleted: 10,
      auditAction: "admin.mfa.reset",
    });
    // The MFA row is gone — and with it, all recovery codes (cascade).
    expect(await db.adminMfa.findUnique({ where: { userId: adminId } })).toBeNull();
    expect(await db.adminMfaRecoveryCode.count({ where: { mfa: { userId: adminId } } })).toBe(0);
    // The admin User row is untouched: same id, email, role, password.
    const user = await db.user.findUnique({ where: { id: adminId } });
    expect(user).not.toBeNull();
    expect(user!.email).toBe(adminEmail);
    expect(user!.role).toBe("ADMIN");
    expect(await bcrypt.compare(ADMIN_PASSWORD, user!.passwordHash!)).toBe(true);
    // One audit row, with no secret material in its metadata.
    const audits = await db.adminAuditLog.findMany({ where: { targetId: adminId } });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("admin.mfa.reset");
    expect(audits[0].targetType).toBe("AdminMfa");
    expect(audits[0].adminUserId).toBeNull();
    const metadata = JSON.stringify(audits[0].metadata ?? {});
    expect(metadata).not.toMatch(/secret|password|hash|totp|token/i);
    // The admin is now unenrolled: the next sign-in requires fresh enrollment.
    const status = await getAdminMfaStatus(adminId);
    expect(status).toEqual({
      enrolled: false,
      enabled: false,
      enabledAt: null,
      hasRecoveryCodes: false,
      unusedRecoveryCodes: 0,
    });
  });

  it("refuses when the admin has no MFA enrollment (nothing to reset)", async () => {
    const result = await resetAdminMfa({
      store: db as unknown as MfaResetStore,
      email: adminEmail,
      dryRun: false,
    });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/no MFA enrollment/);
    // Still exactly one audit row from the successful reset above.
    expect(await db.adminAuditLog.count({ where: { targetId: adminId } })).toBe(1);
  });

  it("refuses a non-admin account and writes nothing", async () => {
    const customer = await db.user.create({
      data: {
        email: `mfa-reset-customer-${Date.now()}@example.invalid`,
        name: "Customer",
        passwordHash: await bcrypt.hash("customer-password", 12),
        emailVerified: new Date(),
        role: "CUSTOMER",
      },
    });
    try {
      const result = await resetAdminMfa({
        store: db as unknown as MfaResetStore,
        email: customer.email,
        dryRun: false,
      });
      expect(result.status).toBe("refused");
      if (result.status === "refused") expect(result.reason).toMatch(/not an admin/);
      expect(await db.user.findUnique({ where: { id: customer.id } })).not.toBeNull();
    } finally {
      await db.user.deleteMany({ where: { id: customer.id } });
    }
  });

  it("refuses an unknown email", async () => {
    const result = await resetAdminMfa({
      store: db as unknown as MfaResetStore,
      email: "nobody@example.invalid",
      dryRun: false,
    });
    expect(result.status).toBe("refused");
  });
});
