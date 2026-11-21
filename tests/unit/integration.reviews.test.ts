// Integration tests — product reviews service (Phase 3, Chunk 9 — D13)
// against a throwaway SQLite database. Run with: npm run test:db
//
// Coverage: verified-purchase gating (DELIVERED only — a CONFIRMED order
// is not enough), pre-moderation (create is PENDING, never counted),
// one review per user per product (409 + unique-race safety net),
// edit-returns-to-pending with in-transaction recompute, approve/reject
// aggregation (approve → rating/count update; reject approved →
// recompute), approved-only newest-first pagination (10/page),
// distribution, display names, and the no-delete-in-V1 rule (no delete
// function exists on the service).
import { describe, expect, it, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

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
  canReviewProduct,
  createReview,
  formatReviewerName,
  getMyReview,
  listApprovedReviews,
  moderateReview,
  updateReview,
} from "@/services/reviews.service";

assertDisposableTestDatabase();

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function seedUser(name?: string) {
  const s = suffix();
  return db.user.create({
    data: { email: `review-test-${s}@example.invalid`, name: name ?? `Test User ${s}` },
  });
}

async function seedProduct() {
  const s = suffix();
  const cat = await db.category.create({
    data: { name: `ReviewCat-${s}`, slug: `reviewcat-${s}`, isActive: true },
  });
  return db.product.create({
    data: {
      name: `Review Watch ${s}`,
      slug: `review-watch-${s}`,
      description: "review test product",
      categoryId: cat.id,
      price: 1000,
      status: "PUBLISHED",
      rating: 0,
      reviewCount: 0,
      inventory: { create: { quantity: 10 } },
      images: { create: { url: "/images/placeholder.svg", sortOrder: 0 } },
    },
  });
}

/** An order for the product in the given status, owned by the user. */
async function seedOrder(userId: string, productId: string, status: string) {
  const ref = `KH-REV-${randomUUID().slice(0, 8).toUpperCase()}`;
  return db.order.create({
    data: {
      reference: ref,
      userId,
      customerName: "Review Test",
      customerEmail: "review-test@example.invalid",
      customerPhone: "03001234567",
      status,
      paymentMethod: "COD",
      paymentStatus: status === "DELIVERED" ? "PAID" : "PENDING",
      isGuest: false,
      idempotencyKey: `idem-${ref}`,
      subtotal: 1000,
      deliveryFee: 0,
      total: 1000,
      shipFullName: "Review Test",
      shipPhone: "03001234567",
      shipLine1: "1 Test Street",
      shipCity: "Lahore",
      shipProvince: "Punjab",
      items: {
        create: {
          productId,
          productName: "Review Watch",
          productSlug: "review-watch",
          unitPrice: 1000,
          quantity: 1,
          lineTotal: 1000,
        },
      },
    },
  });
}

async function productAggregate(productId: string) {
  const p = await db.product.findUniqueOrThrow({
    where: { id: productId },
    select: { rating: true, reviewCount: true },
  });
  return p;
}

describe("reviews service (D13)", () => {
  let productId: string;
  let purchaserId: string;
  let strangerId: string;

  beforeEach(async () => {
    const product = await seedProduct();
    productId = product.id;
    const purchaser = await seedUser("Adeel Khan");
    purchaserId = purchaser.id;
    await seedOrder(purchaserId, productId, "DELIVERED");
    const stranger = await seedUser("Sara Ahmed");
    strangerId = stranger.id;
  });

  it("refuses a non-purchaser with the same 404 as a missing product", async () => {
    const notPurchaser = await createReview({ productId, userId: strangerId, rating: 5 });
    expect(notPurchaser.ok).toBe(false);
    expect(notPurchaser.code).toBe("NOT_FOUND");
    const missing = await createReview({ productId: "no-such-product", userId: purchaserId, rating: 5 });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("NOT_FOUND");
    expect(missing.error).toBe(notPurchaser.error);
  });

  it("refuses a buyer whose order is not DELIVERED yet", async () => {
    const buyer = await seedUser("Bilal Hussain");
    await seedOrder(buyer.id, productId, "CONFIRMED");
    const result = await createReview({ productId, userId: buyer.id, rating: 4 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
    expect(await canReviewProduct(productId, buyer.id)).toBe(false);
  });

  it("creates PENDING with verifiedPurchase, and pending never counts", async () => {
    const result = await createReview({ productId, userId: purchaserId, rating: 5, text: "Excellent!" });
    expect(result.ok).toBe(true);
    expect(result.review?.status).toBe("PENDING");
    expect(result.review?.verifiedPurchase).toBe(true);
    expect(await productAggregate(productId)).toEqual({ rating: 0, reviewCount: 0 });
    expect(await canReviewProduct(productId, purchaserId)).toBe(true);
    expect(await canReviewProduct(productId, strangerId)).toBe(false);
    expect(await canReviewProduct(productId, null as unknown as string)).toBe(false);
  });

  it("rejects a second review for the same product (409) and the unique race", async () => {
    await createReview({ productId, userId: purchaserId, rating: 5 });
    const again = await createReview({ productId, userId: purchaserId, rating: 4 });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("ALREADY_EXISTS");
    // Two concurrent creates: exactly one wins, the other is ALREADY_EXISTS.
    const other = await seedUser("Usman Tariq");
    await seedOrder(other.id, productId, "DELIVERED");
    const [a, b] = await Promise.all([
      createReview({ productId, userId: other.id, rating: 5 }),
      createReview({ productId, userId: other.id, rating: 4 }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)?.code).toBe("ALREADY_EXISTS");
  });

  it("approve updates the aggregate; a second approval averages", async () => {
    const first = await createReview({ productId, userId: purchaserId, rating: 5 });
    await moderateReview({ reviewId: first.review!.id, action: "APPROVED" });
    expect(await productAggregate(productId)).toEqual({ rating: 5, reviewCount: 1 });
    const secondUser = await seedUser("Hina Malik");
    await seedOrder(secondUser.id, productId, "DELIVERED");
    const second = await createReview({ productId, userId: secondUser.id, rating: 3 });
    await moderateReview({ reviewId: second.review!.id, action: "APPROVED" });
    expect(await productAggregate(productId)).toEqual({ rating: 4, reviewCount: 2 });
  });

  it("edit returns an approved review to pending and recomputes in-transaction", async () => {
    const first = await createReview({ productId, userId: purchaserId, rating: 5 });
    await moderateReview({ reviewId: first.review!.id, action: "APPROVED" });
    const secondUser = await seedUser("Hina Malik");
    await seedOrder(secondUser.id, productId, "DELIVERED");
    const second = await createReview({ productId, userId: secondUser.id, rating: 3 });
    await moderateReview({ reviewId: second.review!.id, action: "APPROVED" });
    expect(await productAggregate(productId)).toEqual({ rating: 4, reviewCount: 2 });

    const edited = await updateReview({
      reviewId: first.review!.id,
      userId: purchaserId,
      rating: 4,
      text: "Still good, updated.",
    });
    expect(edited.ok).toBe(true);
    expect(edited.review?.status).toBe("PENDING");
    // Only the 3-star review still counts.
    expect(await productAggregate(productId)).toEqual({ rating: 3, reviewCount: 1 });

    // Re-approving the edited review brings the new rating back in.
    await moderateReview({ reviewId: first.review!.id, action: "APPROVED" });
    expect(await productAggregate(productId)).toEqual({ rating: 3.5, reviewCount: 2 });
  });

  it("rejecting an approved review recomputes; rejecting pending changes nothing", async () => {
    const first = await createReview({ productId, userId: purchaserId, rating: 5 });
    await moderateReview({ reviewId: first.review!.id, action: "APPROVED" });
    expect(await productAggregate(productId)).toEqual({ rating: 5, reviewCount: 1 });
    await moderateReview({ reviewId: first.review!.id, action: "REJECTED" });
    expect(await productAggregate(productId)).toEqual({ rating: 0, reviewCount: 0 });

    const pending = await createReview({ productId, userId: purchaserId, rating: 4 });
    // A rejected review still occupies the one-review-per-user slot: the
    // author edits it back to pending instead of creating a second row.
    expect(pending.ok).toBe(false);
    expect(pending.code).toBe("ALREADY_EXISTS");
    const fresh = await seedUser("Zara Iqbal");
    await seedOrder(fresh.id, productId, "DELIVERED");
    const freshReview = await createReview({ productId, userId: fresh.id, rating: 4 });
    await moderateReview({ reviewId: freshReview.review!.id, action: "REJECTED" });
    expect(await productAggregate(productId)).toEqual({ rating: 0, reviewCount: 0 });
  });

  it("moderation is idempotent and missing reviews 404", async () => {
    const created = await createReview({ productId, userId: purchaserId, rating: 5 });
    const once = await moderateReview({ reviewId: created.review!.id, action: "APPROVED" });
    const twice = await moderateReview({ reviewId: created.review!.id, action: "APPROVED" });
    expect(once.ok).toBe(true);
    expect(twice.ok).toBe(true);
    expect(await productAggregate(productId)).toEqual({ rating: 5, reviewCount: 1 });
    const missing = await moderateReview({ reviewId: "no-such-review", action: "APPROVED" });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("NOT_FOUND");
  });

  it("update enforces ownership (non-owner 404)", async () => {
    const created = await createReview({ productId, userId: purchaserId, rating: 5 });
    const stolen = await updateReview({
      reviewId: created.review!.id,
      userId: strangerId,
      rating: 1,
      text: "hijack",
    });
    expect(stolen.ok).toBe(false);
    expect(stolen.code).toBe("NOT_FOUND");
    const mine = await getMyReview(productId, purchaserId);
    expect(mine?.rating).toBe(5);
    expect(await getMyReview(productId, strangerId)).toBeNull();
  });

  it("lists approved only, newest first, 10 per page, with distribution", async () => {
    const ratings = [5, 5, 4, 3, 1, 5, 4, 2, 5, 3, 4, 5];
    for (let i = 0; i < ratings.length; i++) {
      const user = await seedUser(`First${i} Last${i}`);
      await seedOrder(user.id, productId, "DELIVERED");
      const created = await createReview({ productId, userId: user.id, rating: ratings[i], text: `review ${i}` });
      await moderateReview({ reviewId: created.review!.id, action: "APPROVED" });
      // Stagger createdAt so "newest first" is deterministic.
      await db.review.update({
        where: { id: created.review!.id },
        data: { createdAt: new Date(Date.now() + i * 1000) },
      });
    }
    // One pending + one rejected review must never appear.
    const pendingUser = await seedUser("Pending Person");
    await seedOrder(pendingUser.id, productId, "DELIVERED");
    await createReview({ productId, userId: pendingUser.id, rating: 1, text: "pending" });
    const rejectedUser = await seedUser("Rejected Person");
    await seedOrder(rejectedUser.id, productId, "DELIVERED");
    const rejected = await createReview({ productId, userId: rejectedUser.id, rating: 1, text: "rejected" });
    await moderateReview({ reviewId: rejected.review!.id, action: "REJECTED" });

    const page1 = await listApprovedReviews(productId, 1);
    expect(page1.total).toBe(12);
    expect(page1.reviews).toHaveLength(10);
    expect(page1.reviews[0].text).toBe("review 11");
    expect(page1.reviews[9].text).toBe("review 2");
    expect(page1.distribution).toEqual({ 1: 1, 2: 1, 3: 2, 4: 3, 5: 5 });
    expect(page1.reviews.every((r) => r.verifiedPurchase)).toBe(true);
    expect(page1.reviews[0].reviewerName).toBe("First11 L.");

    const page2 = await listApprovedReviews(productId, 2);
    expect(page2.reviews).toHaveLength(2);
    expect(page2.reviews[0].text).toBe("review 1");
    expect(page2.reviews[1].text).toBe("review 0");
  });

  it("formats reviewer display names from stored names", () => {
    expect(formatReviewerName("Adeel Khan")).toBe("Adeel K.");
    expect(formatReviewerName(null)).toBe("Customer");
  });
});
