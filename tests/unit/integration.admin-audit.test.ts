// Integration test — admin audit log end to end against a throwaway
// SQLite database (PR-12). Run with: npm run test:db
//
// Covers the audit service against the real Prisma layer: recording an
// entry and reading it back with all fields, metadata sanitization on
// write (sensitive keys never persist), transactional atomicity (a record
// written inside a transaction that rolls back does not persist, so a
// failed action produces no success record), list filters + pagination,
// and the two transactional hooks — MFA activation and order status
// change — writing their records atomically with the business action.
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
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
  ADMIN_AUDIT_ACTIONS,
  listAdminAuditLogs,
  recordAdminAudit,
  type AdminAuditContext,
} from "@/services/admin-audit.service";
import {
  activateAdminMfa,
  startAdminMfaEnrollment,
} from "@/services/admin-mfa.service";
import { adminUpdateOrderStatus } from "@/services/orders.service";

// These tests run only through the disposable SQLite test harness. They
// exercise the real Prisma layer and never use the application's configured
// database.
assertDisposableTestDatabase();

const ADMIN_PASSWORD = "CorrectHorseBatteryStaple1";
let adminId = "";
let adminEmail = "";
let auditContext: AdminAuditContext;

beforeAll(async () => {
  process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  adminEmail = `audit-admin-${suffix}@example.invalid`;
  const admin = await db.user.create({
    data: {
      email: adminEmail,
      name: "Audit Admin",
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
      emailVerified: new Date(),
      role: "ADMIN",
    },
  });
  adminId = admin.id;
  auditContext = {
    adminUserId: adminId,
    requestId: "test-request-1",
    ipAddress: "203.0.113.10",
    userAgent: "vitest",
  };
});

afterAll(async () => {
  await db.adminAuditLog.deleteMany({ where: { adminUserId: adminId } });
  await db.adminMfaRecoveryCode.deleteMany({ where: { mfa: { userId: adminId } } });
  await db.adminMfa.deleteMany({ where: { userId: adminId } });
  await db.order.deleteMany({ where: { customerEmail: "audit-order@example.invalid" } });
  await db.user.deleteMany({ where: { id: adminId } });
  await db.$disconnect();
});

describe("admin audit log (integration)", () => {
  it("records an entry and reads it back with all fields", async () => {
    await recordAdminAudit(auditContext, {
      action: ADMIN_AUDIT_ACTIONS.PRODUCT_CREATED,
      targetType: "Product",
      targetId: "prod-1",
      metadata: { name: "Test Widget", price: 999 },
    });
    const { entries, total } = await listAdminAuditLogs({ adminUserId: adminId });
    const entry = entries.find((e) => e.targetId === "prod-1");
    expect(entry).toBeDefined();
    expect(entry?.action).toBe("admin.product.created");
    expect(entry?.targetType).toBe("Product");
    expect(entry?.requestId).toBe("test-request-1");
    expect(entry?.ipAddress).toBe("203.0.113.10");
    expect(entry?.userAgent).toBe("vitest");
    expect(entry?.adminEmail).toBe(adminEmail);
    expect(entry?.metadata).toEqual({ name: "Test Widget", price: 999 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(entry?.createdAt).toBeInstanceOf(Date);
  });

  it("never persists sensitive metadata keys", async () => {
    await recordAdminAudit(auditContext, {
      action: ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED,
      targetType: "StoreSetting",
      metadata: {
        keys: ["cod_enabled"],
        password: "hunter2",
        secret: "s3cr3t",
        token: "abc",
        totpSecret: "JBSW",
      },
    });
    const { entries } = await listAdminAuditLogs({
      adminUserId: adminId,
      action: "admin.settings.updated",
    });
    const entry = entries[0];
    expect(entry?.metadata).toEqual({ keys: ["cod_enabled"] });
  });

  it("does not persist a record when its transaction rolls back", async () => {
    const targetId = `rollback-${Date.now()}`;
    await expect(
      db.$transaction(async (tx) => {
        await recordAdminAudit(
          auditContext,
          {
            action: ADMIN_AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
            targetType: "Order",
            targetId,
            metadata: { from: "PENDING", to: "CONFIRMED" },
          },
          tx
        );
        throw new Error("simulated business failure");
      })
    ).rejects.toThrow("simulated business failure");
    const { entries } = await listAdminAuditLogs({ targetId });
    expect(entries).toHaveLength(0);
  });

  it("filters by action and targetType and paginates", async () => {
    const marker = `page-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      await recordAdminAudit(auditContext, {
        action: ADMIN_AUDIT_ACTIONS.CATEGORY_CREATED,
        targetType: "Category",
        targetId: `${marker}-${i}`,
      });
    }
    const filtered = await listAdminAuditLogs({
      action: "admin.category.created",
      targetType: "Category",
      perPage: 2,
      page: 1,
    });
    expect(filtered.entries.length).toBeLessThanOrEqual(2);
    expect(filtered.total).toBeGreaterThanOrEqual(3);
    expect(filtered.entries.every((e) => e.action === "admin.category.created")).toBe(true);
    const secondPage = await listAdminAuditLogs({
      action: "admin.category.created",
      targetType: "Category",
      perPage: 2,
      page: 2,
    });
    expect(secondPage.page).toBe(2);
    expect(secondPage.entries.length).toBeGreaterThanOrEqual(1);
  });

  it("writes an audit record atomically with MFA activation", async () => {
    const enrollment = await startAdminMfaEnrollment({
      userId: adminId,
      email: adminEmail,
      audit: auditContext,
    });
    expect(enrollment.manualKey).toMatch(/^[A-Z2-7]{32}$/);
    const step = totpTimeStep();
    const code = totpCodeForStep(enrollment.manualKey, step);
    const codes = await activateAdminMfa({ userId: adminId, code, audit: auditContext });
    expect(codes).not.toBeNull();
    expect(codes).toHaveLength(10);
    const { entries } = await listAdminAuditLogs({
      adminUserId: adminId,
      action: "admin.mfa.activated",
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.targetType).toBe("AdminMfa");
    expect(entries[0]?.targetId).toBe(adminId);
    // The enrollment record is there too, from the same hook set.
    const enrolled = await listAdminAuditLogs({
      adminUserId: adminId,
      action: "admin.mfa.enrollment_started",
    });
    expect(enrolled.entries.length).toBeGreaterThanOrEqual(1);
  });

  it("writes an audit record atomically with an order status change", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const order = await db.order.create({
      data: {
        reference: `KHAUDIT${suffix}`,
        idempotencyKey: `audit-order-${suffix}`,
        isGuest: false,
        userId: adminId,
        customerName: "Audit Buyer",
        customerEmail: "audit-order@example.invalid",
        customerPhone: "03001234567",
        shipFullName: "Audit Buyer",
        shipPhone: "03001234567",
        shipLine1: "Test Street 1",
        shipCity: "Lahore",
        shipProvince: "Punjab",
        status: "PENDING",
        paymentMethod: "COD",
        paymentStatus: "PENDING",
        subtotal: 1000,
        total: 1200,
        items: {
          create: {
            productName: "Audit Widget",
            productSlug: "audit-widget",
            unitPrice: 1000,
            quantity: 1,
            lineTotal: 1000,
          },
        },
      },
    });
    const result = await adminUpdateOrderStatus(order.id, "CONFIRMED", auditContext);
    expect(result.ok).toBe(true);
    const { entries } = await listAdminAuditLogs({
      adminUserId: adminId,
      action: "admin.order.status_changed",
      targetId: order.id,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toEqual({
      from: "PENDING",
      to: "CONFIRMED",
      reference: order.reference,
    });
  });
});
