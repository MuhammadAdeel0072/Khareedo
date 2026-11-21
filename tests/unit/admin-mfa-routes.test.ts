// Admin MFA route tests — limiter ordering (Phase 3 MFA fix).
//
// Regression coverage for the bug where POST /api/admin/mfa/setup (and
// verify/activate/replace/disable) consumed a rate-limit slot BEFORE
// checking whether ADMIN_MFA_ENCRYPTION_KEY was configured: with the key
// missing, attempts 1-3 returned 503 and attempt 4 returned 429, so a
// configuration failure burned the budget and masked itself as a rate
// limit. The routes now check `isAdminMfaConfigured()` (real, from the
// service) before any `rateLimit` call, so a 503 never consumes a slot.
//
// The real in-memory limiter is used (only `clientIp` is stubbed, to a
// unique IP per test, so the shared "unknown" bucket cannot leak between
// tests); the DB-touching service functions are stubbed. Auth is stubbed
// via the auth-guard mock. No real database, no real TOTP.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireAdminMfaVerified: vi.fn(),
  getRequestSession: vi.fn(),
  startAdminMfaEnrollment: vi.fn(),
  verifyAdminMfaForSession: vi.fn(),
  activateAdminMfa: vi.fn(),
  startAdminMfaReplacement: vi.fn(),
  disableAdminMfa: vi.fn(),
  ipCounter: { value: 0 },
}));

vi.mock("@/lib/auth-guard", () => {
  class AuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  class MfaRequiredError extends AuthError {
    code: "MFA_ENROLLMENT_REQUIRED" | "MFA_VERIFICATION_REQUIRED";
    constructor(
      code: "MFA_ENROLLMENT_REQUIRED" | "MFA_VERIFICATION_REQUIRED",
      message: string,
      status: number
    ) {
      super(message, status);
      this.code = code;
    }
  }
  return {
    requireAdmin: mocks.requireAdmin,
    requireAdminMfaVerified: mocks.requireAdminMfaVerified,
    getRequestSession: mocks.getRequestSession,
    AuthError,
    MfaRequiredError,
  };
});

// Keep the real isAdminMfaConfigured() (the fix under test); stub only the
// functions that touch the database.
vi.mock("@/services/admin-mfa.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/admin-mfa.service")>();
  return {
    ...actual,
    startAdminMfaEnrollment: mocks.startAdminMfaEnrollment,
    verifyAdminMfaForSession: mocks.verifyAdminMfaForSession,
    activateAdminMfa: mocks.activateAdminMfa,
    startAdminMfaReplacement: mocks.startAdminMfaReplacement,
    disableAdminMfa: mocks.disableAdminMfa,
  };
});

// Real limiter, stubbed client IP (unique per test) so buckets never leak
// between tests through the shared "unknown" IP bucket.
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, clientIp: () => `test-ip-${mocks.ipCounter.value}` };
});
vi.mock("@/lib/db", () => ({ db: {} }));

import { POST as setup } from "@/app/api/admin/mfa/setup/route";
import { POST as verify } from "@/app/api/admin/mfa/verify/route";
import { POST as activate } from "@/app/api/admin/mfa/activate/route";
import { POST as replace } from "@/app/api/admin/mfa/replace/route";
import { POST as disable } from "@/app/api/admin/mfa/disable/route";

const ADMIN_ID = "admin-route-test";
const ADMIN_EMAIL = "admin-route-test@example.invalid";

function adminUser() {
  return {
    id: `${ADMIN_ID}-${mocks.ipCounter.value}`,
    email: ADMIN_EMAIL,
    role: "ADMIN",
    mfaEnabledAt: null,
    mfaLastVerifiedAt: null,
    mfaLastVerifiedSessionId: null,
    sessionSid: "session-1",
  };
}

function request(path: string, body: unknown = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function unauthenticated() {
  const { AuthError } = await import("@/lib/auth-guard");
  return new AuthError("Please sign in to continue", 401);
}

describe("admin MFA routes — missing-key 503 never consumes the rate limit", () => {
  const savedKey = process.env.ADMIN_MFA_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ipCounter.value += 1;
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    mocks.requireAdmin.mockImplementation(async () => adminUser());
    mocks.requireAdminMfaVerified.mockImplementation(async () => adminUser());
    mocks.getRequestSession.mockResolvedValue({ sid: "session-1", iat: Math.floor(Date.now() / 1000) - 60 });
    mocks.startAdminMfaEnrollment.mockResolvedValue({
      qrCodeDataUrl: "data:image/png;base64,QR",
      manualKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      otpauthUrl: "otpauth://totp/test",
    });
    mocks.verifyAdminMfaForSession.mockResolvedValue("invalid");
    mocks.activateAdminMfa.mockResolvedValue(null);
    mocks.startAdminMfaReplacement.mockResolvedValue(null);
    mocks.disableAdminMfa.mockResolvedValue(false);
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    else process.env.ADMIN_MFA_ENCRYPTION_KEY = savedKey;
  });

  it("setup: four 503s with no key, then the full 3-attempt budget is still available", async () => {
    delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    for (let i = 0; i < 4; i++) {
      const response = await setup(request("/api/admin/mfa/setup"));
      expect(response.status).toBe(503);
    }
    // The bug: the 4th attempt used to return 429. With the fix the
    // budget was never touched, so all three real attempts succeed.
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    for (let i = 0; i < 3; i++) {
      expect((await setup(request("/api/admin/mfa/setup"))).status).toBe(200);
    }
    const limited = await setup(request("/api/admin/mfa/setup"));
    expect(limited.status).toBe(429);
  });

  it("verify: six 503s with no key (past the 5-attempt budget), then a real attempt still runs", async () => {
    delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    for (let i = 0; i < 6; i++) {
      expect((await verify(request("/api/admin/mfa/verify", { code: "123456" }))).status).toBe(503);
    }
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    const response = await verify(request("/api/admin/mfa/verify", { code: "123456" }));
    expect(response.status).toBe(400); // reached the service: invalid code
    expect(mocks.verifyAdminMfaForSession).toHaveBeenCalledTimes(1);
  });

  it("activate: six 503s with no key, then a real attempt still runs", async () => {
    delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    for (let i = 0; i < 6; i++) {
      expect((await activate(request("/api/admin/mfa/activate", { code: "123456" }))).status).toBe(503);
    }
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    expect((await activate(request("/api/admin/mfa/activate", { code: "123456" }))).status).toBe(400);
    expect(mocks.activateAdminMfa).toHaveBeenCalledTimes(1);
  });

  it("replace: six 503s with no key, then a real attempt still runs", async () => {
    delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    for (let i = 0; i < 6; i++) {
      const response = await replace(
        request("/api/admin/mfa/replace", { password: "pw", code: "123456" })
      );
      expect(response.status).toBe(503);
    }
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    const response = await replace(request("/api/admin/mfa/replace", { password: "pw", code: "123456" }));
    expect(response.status).toBe(400); // reached the service: bad password/code
    expect(mocks.startAdminMfaReplacement).toHaveBeenCalledTimes(1);
  });

  it("disable: four 503s with no key (past the 3-attempt budget), then a real attempt still runs", async () => {
    delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    for (let i = 0; i < 4; i++) {
      const response = await disable(request("/api/admin/mfa/disable", { password: "pw", code: "123456" }));
      expect(response.status).toBe(503);
    }
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    const response = await disable(request("/api/admin/mfa/disable", { password: "pw", code: "123456" }));
    expect(response.status).toBe(400); // reached the service: bad password/code
    expect(mocks.disableAdminMfa).toHaveBeenCalledTimes(1);
  });
});

describe("admin MFA routes — real attempts are still rate-limited (15-min window)", () => {
  const savedKey = process.env.ADMIN_MFA_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ipCounter.value += 1;
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    mocks.requireAdmin.mockImplementation(async () => adminUser());
    mocks.requireAdminMfaVerified.mockImplementation(async () => adminUser());
    mocks.getRequestSession.mockResolvedValue({ sid: "session-1", iat: Math.floor(Date.now() / 1000) - 60 });
    mocks.startAdminMfaEnrollment.mockResolvedValue({
      qrCodeDataUrl: "data:image/png;base64,QR",
      manualKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      otpauthUrl: "otpauth://totp/test",
    });
    mocks.verifyAdminMfaForSession.mockResolvedValue("invalid");
    mocks.activateAdminMfa.mockResolvedValue(null);
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    else process.env.ADMIN_MFA_ENCRYPTION_KEY = savedKey;
    vi.useRealTimers();
  });

  it("setup: 3 real attempts, then 429 with a Retry-After, then the budget returns after the window", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await setup(request("/api/admin/mfa/setup"))).status).toBe(200);
    }
    const limited = await setup(request("/api/admin/mfa/setup"));
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(15 * 60);

    // No permanent lockout: the fixed 15-minute window expires and the
    // budget is restored.
    vi.useFakeTimers();
    vi.advanceTimersByTime(15 * 60 * 1000 + 1000);
    expect((await setup(request("/api/admin/mfa/setup"))).status).toBe(200);
  });

  it("verify: 5 invalid codes, then 429", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await verify(request("/api/admin/mfa/verify", { code: "000000" }))).status).toBe(400);
    }
    expect((await verify(request("/api/admin/mfa/verify", { code: "000000" }))).status).toBe(429);
    expect(mocks.verifyAdminMfaForSession).toHaveBeenCalledTimes(5);
  });

  it("activate: 5 invalid codes, then 429", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await activate(request("/api/admin/mfa/activate", { code: "000000" }))).status).toBe(400);
    }
    expect((await activate(request("/api/admin/mfa/activate", { code: "000000" }))).status).toBe(429);
    expect(mocks.activateAdminMfa).toHaveBeenCalledTimes(5);
  });
});

describe("admin MFA routes — verification outcomes", () => {
  const savedKey = process.env.ADMIN_MFA_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ipCounter.value += 1;
    process.env.ADMIN_MFA_ENCRYPTION_KEY = TEST_KEY;
    mocks.requireAdmin.mockImplementation(async () => adminUser());
    mocks.requireAdminMfaVerified.mockImplementation(async () => adminUser());
    mocks.getRequestSession.mockResolvedValue({ sid: "session-1", iat: Math.floor(Date.now() / 1000) - 60 });
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ADMIN_MFA_ENCRYPTION_KEY;
    else process.env.ADMIN_MFA_ENCRYPTION_KEY = savedKey;
  });

  it("verify: a session without a sid gets 401 SESSION_REBIND_REQUIRED, not a wrong-code error", async () => {
    mocks.getRequestSession.mockResolvedValue({ iat: Math.floor(Date.now() / 1000) - 60, sid: undefined });
    const response = await verify(request("/api/admin/mfa/verify", { code: "123456" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_REBIND_REQUIRED" });
    expect(mocks.verifyAdminMfaForSession).not.toHaveBeenCalled();
  });

  it("verify: a missing session gets 401 SESSION_REBIND_REQUIRED", async () => {
    mocks.getRequestSession.mockResolvedValue(null);
    const response = await verify(request("/api/admin/mfa/verify", { code: "123456" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_REBIND_REQUIRED" });
  });

  it("verify: an invalid TOTP code gets 400 and does not verify the session", async () => {
    mocks.verifyAdminMfaForSession.mockResolvedValue("invalid");
    const response = await verify(request("/api/admin/mfa/verify", { code: "000000" }));
    expect(response.status).toBe(400);
    expect(mocks.verifyAdminMfaForSession).toHaveBeenCalledWith(
      expect.objectContaining({ code: "000000", sessionSid: "session-1" })
    );
  });

  it("verify: a valid TOTP code gets 200", async () => {
    mocks.verifyAdminMfaForSession.mockResolvedValue("verified");
    const response = await verify(request("/api/admin/mfa/verify", { code: "123456" }));
    expect(response.status).toBe(200);
  });

  it("verify: a recovery code (11 chars) is accepted when the service verifies it", async () => {
    mocks.verifyAdminMfaForSession.mockResolvedValue("verified");
    const response = await verify(request("/api/admin/mfa/verify", { code: "ABCDE-FGHJK" }));
    expect(response.status).toBe(200);
    expect(mocks.verifyAdminMfaForSession).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ABCDE-FGHJK" })
    );
  });

  it("verify: an admin who never enrolled gets 400 MFA_ENROLLMENT_REQUIRED", async () => {
    mocks.verifyAdminMfaForSession.mockResolvedValue("not-enrolled");
    const response = await verify(request("/api/admin/mfa/verify", { code: "123456" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MFA_ENROLLMENT_REQUIRED" });
  });

  it("setup: an unauthenticated caller gets 401 and enrollment never starts", async () => {
    mocks.requireAdmin.mockRejectedValue(await unauthenticated());
    const response = await setup(request("/api/admin/mfa/setup"));
    expect(response.status).toBe(401);
    expect(mocks.startAdminMfaEnrollment).not.toHaveBeenCalled();
  });

  it("verify: an unauthenticated caller gets 401 and nothing is verified", async () => {
    mocks.requireAdmin.mockRejectedValue(await unauthenticated());
    const response = await verify(request("/api/admin/mfa/verify", { code: "123456" }));
    expect(response.status).toBe(401);
    expect(mocks.verifyAdminMfaForSession).not.toHaveBeenCalled();
  });

  it("replace: an unauthenticated caller gets 401 and replacement never starts", async () => {
    mocks.requireAdminMfaVerified.mockRejectedValue(await unauthenticated());
    const response = await replace(request("/api/admin/mfa/replace", { password: "pw", code: "123456" }));
    expect(response.status).toBe(401);
    expect(mocks.startAdminMfaReplacement).not.toHaveBeenCalled();
  });

  it("activate: a valid first code returns the recovery codes once", async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAAA-0000${i}`);
    mocks.activateAdminMfa.mockResolvedValue(codes);
    const response = await activate(request("/api/admin/mfa/activate", { code: "123456" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recoveryCodes: codes });
  });

  it("setup: a successful enrollment returns the QR code and manual key", async () => {
    mocks.startAdminMfaEnrollment.mockResolvedValue({
      qrCodeDataUrl: "data:image/png;base64,QR",
      manualKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      otpauthUrl: "otpauth://totp/test",
    });
    const response = await setup(request("/api/admin/mfa/setup"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      qrCodeDataUrl: "data:image/png;base64,QR",
      manualKey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    });
  });
});
