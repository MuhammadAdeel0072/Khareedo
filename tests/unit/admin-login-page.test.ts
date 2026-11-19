// Admin login page must not redirect-loop for a password-reset-invalidated
// session (PR-25).
//
// The page used to read the raw session (getServerSession) and redirect any
// ADMIN-role session to /admin. A reset-invalidated admin session is still
// cryptographically valid, so the page redirected to /admin — but the panel
// layout enforces the guard (which rejects invalidated sessions) and sent
// the admin back to /login, looping forever. The fix reads the session
// through getSessionUser(), which returns null for an invalidated session,
// so the login form is shown and the admin can sign in fresh.
//
// This test renders the REAL page with a mocked NextAuth session and a
// mocked database: the only thing mocked away is the session source and
// the database, not the code under test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetServerSession, mockUserFindUnique, mockRedirect } = vi.hoisted(
  () => ({
    mockGetServerSession: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockRedirect: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    }),
  })
);

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mockUserFindUnique } } }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/components/admin/admin-login-form", () => ({
  AdminLoginForm: () => null,
}));
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }));

import AdminLoginPage from "@/app/admin/login/page";

function dbAdmin(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-1",
    email: "admin@example.com",
    name: "Admin",
    role: "ADMIN",
    passwordChangedAt: null,
    adminMfa: null,
    ...overrides,
  };
}

// Calls the page and returns the redirect target, or null when the page
// renders the login form instead of redirecting.
async function renderPage(): Promise<string | null> {
  try {
    await AdminLoginPage();
    return null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT:")) {
      return error.message.slice("NEXT_REDIRECT:".length);
    }
    throw error;
  }
}

describe("admin login page redirect (PR-25)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects a valid admin session to /admin", async () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    mockGetServerSession.mockResolvedValue({
      user: { id: "admin-1" },
      iat,
    });
    mockUserFindUnique.mockResolvedValue(dbAdmin());

    expect(await renderPage()).toBe("/admin");
  });

  it("does NOT redirect a password-reset-invalidated admin session (no loop)", async () => {
    // Session issued at iat; the password was changed a minute later.
    const iat = Math.floor(Date.now() / 1000) - 3600;
    mockGetServerSession.mockResolvedValue({
      user: { id: "admin-1" },
      iat,
    });
    mockUserFindUnique.mockResolvedValue(
      dbAdmin({ passwordChangedAt: new Date((iat + 60) * 1000) })
    );

    expect(await renderPage()).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("shows the login form when there is no session", async () => {
    mockGetServerSession.mockResolvedValue(null);

    expect(await renderPage()).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
