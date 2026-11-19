// Unit tests — admin audit log service (PR-12).
// Covers metadata sanitization (sensitive keys are stripped, values are
// bounded) and audit-context construction. Database-backed behaviour
// (record + list + transactional atomicity) is covered by
// tests/unit/integration.admin-audit.test.ts, which runs under test:db.
import { describe, expect, it } from "vitest";
import {
  adminAuditContext,
  sanitizeAuditMetadata,
} from "@/services/admin-audit.service";

describe("sanitizeAuditMetadata", () => {
  it("returns undefined for non-object input", () => {
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
    expect(sanitizeAuditMetadata("a string")).toBeUndefined();
    expect(sanitizeAuditMetadata(42)).toBeUndefined();
    expect(sanitizeAuditMetadata(null)).toBeUndefined();
  });

  it("returns undefined when nothing safe remains", () => {
    expect(sanitizeAuditMetadata({ password: "secret" })).toBeUndefined();
    expect(sanitizeAuditMetadata({})).toBeUndefined();
  });

  it("keeps safe fields and drops sensitive keys", () => {
    const cleaned = sanitizeAuditMetadata({
      from: "PENDING",
      to: "DELIVERED",
      reference: "KH123",
      password: "hunter2",
      secret: "s3cr3t",
      token: "abc",
      totpSecret: "JBSW",
      recoveryCode: "ABCDE-FGHIJ",
      sessionCookie: "xyz",
      authorization: "Bearer abc",
      apiKey: "key",
      privateKey: "key",
      credential: "cred",
    });
    expect(cleaned).toEqual({ from: "PENDING", to: "DELIVERED", reference: "KH123" });
  });

  it("strips sensitive keys nested inside objects and arrays", () => {
    const cleaned = sanitizeAuditMetadata({
      order: { id: "o1", password: "x" },
      items: [{ name: "Widget", token: "t" }, { name: "Gadget" }],
    });
    expect(cleaned).toEqual({
      order: { id: "o1" },
      items: [{ name: "Widget" }, { name: "Gadget" }],
    });
  });

  it("truncates long strings and drops null values", () => {
    const long = "x".repeat(1000);
    const cleaned = sanitizeAuditMetadata({ note: long, empty: null, keep: "yes" });
    expect(cleaned).toEqual({ note: "x".repeat(500), keep: "yes" });
  });

  it("serializes dates to ISO strings", () => {
    const date = new Date("2026-11-19T10:00:00.000Z");
    const cleaned = sanitizeAuditMetadata({ at: date });
    expect(cleaned).toEqual({ at: "2026-11-19T10:00:00.000Z" });
  });

  it("bounds depth and key count", () => {
    const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
    const cleaned = sanitizeAuditMetadata(deep) as Record<string, unknown>;
    // Depth 3: the value under b (depth 3) is dropped, so c never appears.
    expect(cleaned).toEqual({ a: { b: {} } });

    const many: Record<string, number> = {};
    for (let i = 0; i < 100; i += 1) many[`key${i}`] = i;
    const bounded = sanitizeAuditMetadata(many) as Record<string, unknown>;
    expect(Object.keys(bounded)).toHaveLength(50);
  });
});

describe("adminAuditContext", () => {
  it("builds the context from a request and the authenticated admin", () => {
    // A trusted proxy is configured, so the forwarded header is honoured.
    process.env.TRUSTED_PROXY_IPS = "203.0.113.1";
    try {
      const request = new Request("https://example.com/api/admin/orders/1/status", {
        headers: {
          "x-forwarded-for": "203.0.113.10",
          "user-agent": "Mozilla/5.0 (test)",
        },
      });
      const context = adminAuditContext(request, {
        id: "admin-1",
        email: "admin@example.com",
        role: "ADMIN",
        mfaEnabledAt: null,
        mfaLastVerifiedAt: null,
        mfaLastVerifiedSessionId: null,
        sessionSid: "session-aaa",
      });
      expect(context.adminUserId).toBe("admin-1");
      expect(context.ipAddress).toBe("203.0.113.10");
      expect(context.userAgent).toBe("Mozilla/5.0 (test)");
      expect(typeof context.requestId).toBe("string");
    } finally {
      delete process.env.TRUSTED_PROXY_IPS;
    }
  });

  it("ignores a spoofable forwarded header when no trusted proxy is configured", () => {
    // Fail-safe (Phase 2, area G): without TRUSTED_PROXY_IPS, X-Forwarded-For
    // is client-controlled and must not reach the audit log as a real IP.
    delete process.env.TRUSTED_PROXY_IPS;
    const request = new Request("https://example.com/api/admin/orders/1/status", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const context = adminAuditContext(request, {
      id: "admin-1",
      email: "admin@example.com",
      role: "ADMIN",
      mfaEnabledAt: null,
      mfaLastVerifiedAt: null,
      mfaLastVerifiedSessionId: null,
      sessionSid: "session-aaa",
    });
    expect(context.ipAddress).toBe("unknown");
  });

  it("falls back to unknown IP and no user-agent when headers are absent", () => {
    const request = new Request("https://example.com/api/admin/orders/1/status");
    const context = adminAuditContext(request, {
      id: "admin-1",
      email: "admin@example.com",
      role: "ADMIN",
      mfaEnabledAt: null,
      mfaLastVerifiedAt: null,
      mfaLastVerifiedSessionId: null,
      sessionSid: "session-aaa",
    });
    expect(context.ipAddress).toBe("unknown");
    expect(context.userAgent).toBeUndefined();
  });
});
