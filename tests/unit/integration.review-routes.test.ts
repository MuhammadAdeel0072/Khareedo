// Route tests — product review endpoints (Phase 3, Chunk 9 — D13). The
// service invariants live in integration.reviews.test.ts; this file pins
// the HTTP mapping: 401 unauthenticated, 404 missing product /
// non-purchaser / non-owner, 409 duplicate review, 422 validation,
// 429 spam limits with Retry-After. Run with: npm run test:db
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const sessionUser = vi.hoisted(() => ({ id: "" }));
const adminUser = vi.hoisted(() => ({ id: "" }));

// Same mock shape as integration.order-cancel-route.test.ts: the error
// classes live inside the factory because vi.mock is hoisted.
vi.mock("@/lib/auth-guard", () => {
  class TestAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  class TestMfaError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 403) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    AuthError: TestAuthError,
    MfaRequiredError: TestMfaError,
    getSessionUser: async () => (sessionUser.id ? { id: sessionUser.id } : null),
    requireUser: async () => {
      if (!sessionUser.id) throw new TestAuthError("Please sign in to continue", 401);
      return { id: sessionUser.id };
    },
    requireAdminMfaVerified: async () => {
      if (!adminUser.id) throw new TestAuthError("Please sign in to continue", 401);
      return { id: adminUser.id };
    },
  };
});

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
import { GET as listReviews, POST as createReviewRoute } from "@/app/api/products/[id]/reviews/route";
import { PATCH as updateReviewRoute } from "@/app/api/account/reviews/[id]/route";
import { GET as listAdminReviews } from "@/app/api/admin/reviews/route";
import { PATCH as moderateReviewRoute } from "@/app/api/admin/reviews/[id]/route";

assertDisposableTestDatabase();

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function seedUser(name?: string) {
  const s = suffix();
  return db.user.create({
    data: { email: `review-route-${s}@example.invalid`, name: name ?? `Route User ${s}` },
  });
}

async function seedProduct() {
  const s = suffix();
  const cat = await db.category.create({
    data: { name: `RouteCat-${s}`, slug: `routecat-${s}`, isActive: true },
  });
  return db.product.create({
    data: {
      name: `Route Watch ${s}`,
      slug: `route-watch-${s}`,
      description: "route test product",
      categoryId: cat.id,
      price: 1000,
      status: "PUBLISHED",
      inventory: { create: { quantity: 10 } },
      images: { create: { url: "/images/placeholder.svg", sortOrder: 0 } },
    },
  });
}

async function seedDeliveredOrder(userId: string, productId: string) {
  const ref = `KH-RR-${randomUUID().slice(0, 8).toUpperCase()}`;
  return db.order.create({
    data: {
      reference: ref,
      userId,
      customerName: "Route Test",
      customerEmail: "route-test@example.invalid",
      customerPhone: "03001234567",
      status: "DELIVERED",
      paymentMethod: "COD",
      paymentStatus: "PAID",
      isGuest: false,
      idempotencyKey: `idem-${ref}`,
      subtotal: 1000,
      deliveryFee: 0,
      total: 1000,
      shipFullName: "Route Test",
      shipPhone: "03001234567",
      shipLine1: "1 Test Street",
      shipCity: "Lahore",
      shipProvince: "Punjab",
      items: {
        create: {
          productId,
          productName: "Route Watch",
          productSlug: "route-watch",
          unitPrice: 1000,
          quantity: 1,
          lineTotal: 1000,
        },
      },
    },
  });
}

function postJson(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("review routes", () => {
  let productId: string;
  let purchaserId: string;
  let strangerId: string;

  beforeEach(async () => {
    sessionUser.id = "";
    adminUser.id = "";
    const product = await seedProduct();
    productId = product.id;
    const purchaser = await seedUser("Adeel Khan");
    purchaserId = purchaser.id;
    await seedDeliveredOrder(purchaserId, productId);
    const stranger = await seedUser("Sara Ahmed");
    strangerId = stranger.id;
  });

  afterAll(async () => {
    sessionUser.id = "";
    adminUser.id = "";
  });

  it("POST 401 when unauthenticated", async () => {
    const res = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: productId }),
    });
    expect(res.status).toBe(401);
  });

  it("POST 404 for a missing product", async () => {
    sessionUser.id = purchaserId;
    const res = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: "no-such-product" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST 404 for a non-purchaser (same shape as missing product)", async () => {
    sessionUser.id = strangerId;
    const missing = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: "no-such-product" }),
    });
    const notPurchaser = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: productId }),
    });
    expect(notPurchaser.status).toBe(404);
    const missingBody = await missing.json();
    const deniedBody = await notPurchaser.json();
    expect(deniedBody.error).toBe(missingBody.error);
  });

  it("POST 422 for invalid rating or over-long text", async () => {
    sessionUser.id = purchaserId;
    for (const body of [{ rating: 0 }, { rating: 6 }, { rating: 3.5 }, { rating: 5, text: "x".repeat(1001) }, {}]) {
      const res = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", body), {
        params: Promise.resolve({ id: productId }),
      });
      expect(res.status).toBe(422);
    }
  });

  it("POST 409 on a duplicate review, 200 on first create", async () => {
    sessionUser.id = purchaserId;
    const first = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5, text: "Great" }), {
      params: Promise.resolve({ id: productId }),
    });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.ok).toBe(true);
    expect(body.review.status).toBe("PENDING");
    const second = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 4 }), {
      params: Promise.resolve({ id: productId }),
    });
    expect(second.status).toBe(409);
  });

  it("POST 429 on the 6th review in an hour, with Retry-After", async () => {
    // Fresh user: the per-user bucket (5/hour) is untouched by other tests.
    const heavy = await seedUser("Heavy Reviewer");
    for (let i = 0; i < 5; i++) {
      const p = await seedProduct();
      await seedDeliveredOrder(heavy.id, p.id);
      sessionUser.id = heavy.id;
      const res = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
        params: Promise.resolve({ id: p.id }),
      });
      expect(res.status).toBe(200);
    }
    const sixth = await seedProduct();
    await seedDeliveredOrder(heavy.id, sixth.id);
    const res = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: sixth.id }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("PATCH account review 401 / 404 non-owner / 200 + back to pending", async () => {
    sessionUser.id = purchaserId;
    const created = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: productId }),
    });
    const reviewId = (await created.json()).review.id;
    // Approve it first so the edit demonstrably returns it to pending.
    adminUser.id = "admin-1";
    const approved = await moderateReviewRoute(
      new Request("http://localhost/api/admin/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVED" }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(approved.status).toBe(200);

    sessionUser.id = "";
    const unauth = await updateReviewRoute(
      new Request("http://localhost/api/account/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 4 }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(unauth.status).toBe(401);

    sessionUser.id = strangerId;
    const stolen = await updateReviewRoute(
      new Request("http://localhost/api/account/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 1 }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(stolen.status).toBe(404);

    sessionUser.id = purchaserId;
    const edited = await updateReviewRoute(
      new Request("http://localhost/api/account/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 4, text: "Updated" }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(edited.status).toBe(200);
    const body = await edited.json();
    expect(body.review.status).toBe("PENDING");
    expect(body.review.rating).toBe(4);
  });

  it("PATCH account review 429 on the 61st edit in a minute, with Retry-After", async () => {
    // The overnight perf stream added a 60/min per-user limit to the
    // edit route (account-review-update:<userId>); this pins it. Note
    // it is deliberately looser than create's spam limits (5/hour per
    // user + 20/hour per IP): an edit returns the review to pending
    // moderation, so edit spam is moderated rather than published.
    // Fresh user: the per-user bucket must be untouched by other tests.
    const heavy = await seedUser("Heavy Editor");
    await seedDeliveredOrder(heavy.id, productId);
    sessionUser.id = heavy.id;
    const created = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: productId }),
    });
    expect(created.status).toBe(200);
    const reviewId = (await created.json()).review.id;
    const patch = (rating: number) =>
      updateReviewRoute(
        new Request("http://localhost/api/account/reviews/x", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating }),
        }),
        { params: Promise.resolve({ id: reviewId }) }
      );
    for (let i = 0; i < 60; i++) {
      const res = await patch(i % 2 === 0 ? 5 : 4);
      expect(res.status).toBe(200);
    }
    const limited = await patch(5);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect((await limited.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/try again in \d+s/),
    });
  });

  it("GET public list returns approved only", async () => {
    sessionUser.id = purchaserId;
    const created = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5, text: "Shown" }), {
      params: Promise.resolve({ id: productId }),
    });
    const reviewId = (await created.json()).review.id;
    adminUser.id = "admin-1";
    await moderateReviewRoute(
      new Request("http://localhost/api/admin/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVED" }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    // A second, still-pending review must not appear.
    const pendingUser = await seedUser("Pending Person");
    await seedDeliveredOrder(pendingUser.id, productId);
    sessionUser.id = pendingUser.id;
    await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 1, text: "Hidden" }), {
      params: Promise.resolve({ id: productId }),
    });

    const res = await listReviews(new Request(`http://localhost/api/products/${productId}/reviews`), {
      params: Promise.resolve({ id: productId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.reviews[0].text).toBe("Shown");
    expect(body.reviews[0].reviewerName).toBe("Adeel K.");
    expect(body.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });

    const missing = await listReviews(new Request("http://localhost/api/products/nope/reviews"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("admin list + moderate require admin; moderate 422/404/200", async () => {
    const noAdmin = await listAdminReviews(new Request("http://localhost/api/admin/reviews"));
    expect(noAdmin.status).toBe(401);

    sessionUser.id = purchaserId;
    const created = await createReviewRoute(postJson("http://localhost/api/products/x/reviews", { rating: 5 }), {
      params: Promise.resolve({ id: productId }),
    });
    const reviewId = (await created.json()).review.id;

    const noAdminModerate = await moderateReviewRoute(
      new Request("http://localhost/api/admin/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVED" }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(noAdminModerate.status).toBe(401);

    adminUser.id = "admin-1";
    const list = await listAdminReviews(new Request("http://localhost/api/admin/reviews?status=PENDING"));
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.reviews.some((r: { id: string }) => r.id === reviewId)).toBe(true);

    const badAction = await moderateReviewRoute(
      new Request("http://localhost/api/admin/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "PENDING" }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(badAction.status).toBe(422);

    const missing = await moderateReviewRoute(
      new Request("http://localhost/api/admin/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVED" }),
      }),
      { params: Promise.resolve({ id: "no-such-review" }) }
    );
    expect(missing.status).toBe(404);

    const approved = await moderateReviewRoute(
      new Request("http://localhost/api/admin/reviews/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVED" }),
      }),
      { params: Promise.resolve({ id: reviewId }) }
    );
    expect(approved.status).toBe(200);
    const product = await db.product.findUniqueOrThrow({ where: { id: productId }, select: { rating: true, reviewCount: true } });
    expect(product).toEqual({ rating: 5, reviewCount: 1 });
  });
});
