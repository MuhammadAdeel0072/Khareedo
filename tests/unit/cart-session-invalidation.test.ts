// Cart API must reject password-reset-invalidated sessions (PR-25).
//
// resolveCartImpl used to read the raw session (getRequestSession) and
// resolve the signed-in user's cart from session.user.id, bypassing the
// auth guard's password-change invalidation. A session invalidated by a
// password reset therefore still reached the user's cart. The fix routes
// cart resolution through getSessionUser(), which returns null for an
// invalidated session, so the cart falls back to the guest path.
//
// These tests exercise the REAL cart service and the REAL auth guard with
// a mocked NextAuth session and a mocked database: the only thing mocked
// away is the session source and the database, not the code under test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetServerSession, mockUserFindUnique, mockCartFindUnique } =
  vi.hoisted(() => ({
    mockGetServerSession: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockCartFindUnique: vi.fn(),
  }));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: mockUserFindUnique },
    cart: { findUnique: mockCartFindUnique, create: vi.fn() },
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn() }),
}));

import { resolveCart } from "@/services/cart.service";

function dbUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "customer-1",
    email: "customer@example.com",
    name: "Customer",
    role: "CUSTOMER",
    passwordChangedAt: null,
    adminMfa: null,
    ...overrides,
  };
}

describe("cart resolution honours password-reset invalidation (PR-25)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The user owns a cart. Whether resolveCart returns it depends only on
    // whether the session is valid.
    mockCartFindUnique.mockResolvedValue({ id: "cart-1" });
  });

  it("resolves the signed-in user's cart for a valid session", async () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    mockGetServerSession.mockResolvedValue({
      user: { id: "customer-1" },
      iat,
    });
    mockUserFindUnique.mockResolvedValue(dbUser());

    const cart = await resolveCart();

    expect(cart).toEqual({ id: "cart-1", isGuest: false });
    expect(mockCartFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "customer-1" } })
    );
  });

  it("does NOT resolve the user's cart for a password-reset-invalidated session", async () => {
    // Session issued at iat; the password was changed a minute later.
    const iat = Math.floor(Date.now() / 1000) - 3600;
    mockGetServerSession.mockResolvedValue({
      user: { id: "customer-1" },
      iat,
    });
    mockUserFindUnique.mockResolvedValue(
      dbUser({ passwordChangedAt: new Date((iat + 60) * 1000) })
    );

    const cart = await resolveCart();

    // No user cart (invalidated session) and no guest cookie: no cart.
    expect(cart).toBeNull();
    expect(mockCartFindUnique).not.toHaveBeenCalled();
  });
});
