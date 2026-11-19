// Admin MFA guard tests (PR-10, sid binding in the security-finalization
// PR). The guard re-reads MFA state from the DB on every request and
// requires lastVerifiedAt to be after the session's issued-at time AND the
// verification to be bound to this session (lastVerifiedSessionId === the
// session's `sid` claim), so each new login must verify MFA again and a
// verification in one session cannot authorize another session.
import { describe, expect, it, vi } from "vitest";

const { mockGetServerSession, mockDbUser } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockDbUser: { findUnique: vi.fn() },
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/db", () => ({ db: { user: mockDbUser } }));

import {
  MfaRequiredError,
  isMfaVerifiedForSession,
  requireAdmin,
  requireAdminMfaVerified,
} from "@/lib/auth-guard";

function sessionUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-1",
    email: "admin@khareedo.pk",
    name: "Admin",
    role: "ADMIN",
    passwordChangedAt: null,
    adminMfa: null,
    ...overrides,
  };
}

describe("isMfaVerifiedForSession", () => {
  const sid = "session-aaa";
  it("is verified only when lastVerifiedAt is after the session issued-at and bound to this session", () => {
    const iat = 1_700_000_000; // session issued at this second
    expect(isMfaVerifiedForSession(new Date(iat * 1000 + 1000), iat, sid, sid)).toBe(true);
    expect(isMfaVerifiedForSession(new Date(iat * 1000), iat, sid, sid)).toBe(false);
    expect(isMfaVerifiedForSession(new Date(iat * 1000 - 1000), iat, sid, sid)).toBe(false);
  });

  it("is not verified when either value is missing", () => {
    expect(isMfaVerifiedForSession(null, 1_700_000_000, sid, sid)).toBe(false);
    expect(isMfaVerifiedForSession(new Date(), undefined, sid, sid)).toBe(false);
    expect(isMfaVerifiedForSession(null, undefined, sid, sid)).toBe(false);
    expect(isMfaVerifiedForSession(new Date(), 1_700_000_000, null, sid)).toBe(false);
    expect(isMfaVerifiedForSession(new Date(), 1_700_000_000, sid, undefined)).toBe(false);
    expect(isMfaVerifiedForSession(new Date(), 1_700_000_000, null, undefined)).toBe(false);
  });

  it("is not verified when the verification belongs to a different session", () => {
    const iat = 1_700_000_000;
    // Verified after iat, but in session-bbb — this session (session-aaa)
    // must verify itself. This is the M-4 hole: a stolen pre-verification
    // token used to become valid once the victim verified elsewhere.
    expect(isMfaVerifiedForSession(new Date(iat * 1000 + 1000), iat, "session-bbb", sid)).toBe(false);
  });

  it("is not verified for a same-second session (the old edge case)", () => {
    // A new session created in the exact second the admin verified used to
    // pass the timestamp check; the sid binding closes it.
    const iat = 1_700_000_000;
    expect(isMfaVerifiedForSession(new Date(iat * 1000), iat, sid, "session-other")).toBe(false);
  });
});

describe("requireAdminMfaVerified", () => {
  it("returns the admin when MFA is enabled and verified for this session", async () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1" }, iat, sid: "session-aaa" });
    mockDbUser.findUnique.mockResolvedValue(
      sessionUser({
        adminMfa: {
          enabledAt: new Date("2026-11-19T09:00:00.000Z"),
          lastVerifiedAt: new Date(),
          lastVerifiedSessionId: "session-aaa",
        },
      })
    );
    const user = await requireAdminMfaVerified();
    expect(user.id).toBe("admin-1");
    expect(user.role).toBe("ADMIN");
  });

  it("requires verification when the session verified in a different session", async () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    // Verified after iat, but bound to session-bbb; this session is
    // session-aaa, so it must verify itself (M-4 binding).
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1" }, iat, sid: "session-aaa" });
    mockDbUser.findUnique.mockResolvedValue(
      sessionUser({
        adminMfa: {
          enabledAt: new Date("2026-11-19T09:00:00.000Z"),
          lastVerifiedAt: new Date(),
          lastVerifiedSessionId: "session-bbb",
        },
      })
    );
    await expect(requireAdminMfaVerified()).rejects.toMatchObject({
      code: "MFA_VERIFICATION_REQUIRED",
      status: 401,
    });
  });

  it("requires verification for a legacy session with no sid (fail closed)", async () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    // No sid on the token: issued before the sid change. Even though the
    // verification is recent, the guard cannot bind it to this session.
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1" }, iat });
    mockDbUser.findUnique.mockResolvedValue(
      sessionUser({
        adminMfa: {
          enabledAt: new Date("2026-11-19T09:00:00.000Z"),
          lastVerifiedAt: new Date(),
          lastVerifiedSessionId: "session-aaa",
        },
      })
    );
    await expect(requireAdminMfaVerified()).rejects.toMatchObject({
      code: "MFA_VERIFICATION_REQUIRED",
      status: 401,
    });
  });

  it("requires enrollment when the admin has not enabled MFA", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1" }, iat: 1_700_000_000 });
    mockDbUser.findUnique.mockResolvedValue(sessionUser({ adminMfa: null }));
    await expect(requireAdminMfaVerified()).rejects.toMatchObject({
      code: "MFA_ENROLLMENT_REQUIRED",
      status: 403,
    });
  });

  it("requires enrollment when MFA is enrolled but not yet activated", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1" }, iat: 1_700_000_000 });
    mockDbUser.findUnique.mockResolvedValue(
      sessionUser({ adminMfa: { enabledAt: null, lastVerifiedAt: null } })
    );
    await expect(requireAdminMfaVerified()).rejects.toBeInstanceOf(MfaRequiredError);
    await expect(requireAdminMfaVerified()).rejects.toMatchObject({
      code: "MFA_ENROLLMENT_REQUIRED",
    });
  });

  it("requires verification when MFA is enabled but this session has not verified it", async () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1" }, iat });
    // lastVerifiedAt is BEFORE the session was issued (a previous session).
    mockDbUser.findUnique.mockResolvedValue(
      sessionUser({
        adminMfa: {
          enabledAt: new Date("2026-11-19T09:00:00.000Z"),
          lastVerifiedAt: new Date((iat - 3600) * 1000),
        },
      })
    );
    await expect(requireAdminMfaVerified()).rejects.toMatchObject({
      code: "MFA_VERIFICATION_REQUIRED",
      status: 401,
    });
  });

  it("a customer is never subject to MFA enforcement (403, not MFA)", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "cust-1" }, iat: 1_700_000_000 });
    mockDbUser.findUnique.mockResolvedValue(sessionUser({ id: "cust-1", role: "CUSTOMER", adminMfa: null }));
    await expect(requireAdminMfaVerified()).rejects.toMatchObject({
      message: "Administrator access required",
      status: 403,
    });
    // And plain requireAdmin still works for customers where it is used.
    await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
  });

  it("an unauthenticated caller gets 401", async () => {
    mockGetServerSession.mockResolvedValue(null);
    mockDbUser.findUnique.mockResolvedValue(null);
    await expect(requireAdminMfaVerified()).rejects.toMatchObject({
      message: "Please sign in to continue",
      status: 401,
    });
  });
});
