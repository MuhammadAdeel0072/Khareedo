// Product reviews (Phase 3, Chunk 9 — D13): verified purchasers only,
// pre-moderation, one review per user per product (editable; edits return
// to pending). Product.rating / reviewCount are maintained by
// in-transaction aggregation over APPROVED reviews only — the aggregation
// runs inside the same transaction as the review write / status change,
// never as a separate fire-and-forget step, so the displayed rating can
// never disagree with the approved reviews.
//
// No customer delete in V1: a customer may edit their review but not
// delete it (an admin rejects it instead). No per-variant reviews: a
// review is for the product, not a variant (Chunk 8).
import { db } from "@/lib/db";

export const REVIEW_PAGE_SIZE = 10;

export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

export const REVIEW_STATUSES: ReviewStatus[] = ["PENDING", "APPROVED", "REJECTED"];

/** The transaction client type (see orders.service.ts): the app adds
 * $extends to the client, so Prisma.TransactionClient is not assignable. */
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export type ReviewResultCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "INVALID"
  | "ERROR";

export interface ReviewResult {
  ok: boolean;
  error?: string;
  code?: ReviewResultCode;
  review?: {
    id: string;
    productId: string;
    userId: string;
    rating: number;
    text: string | null;
    status: string;
    verifiedPurchase: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
}

/** Reviewer display name: first name + last initial (D13). A user with no
 * stored name renders as "Customer" — the verified-purchase badge, not
 * the name, is what vouches for them. */
export function formatReviewerName(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Customer";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

/** Recompute Product.rating / reviewCount from APPROVED reviews only,
 * inside the caller's transaction. Rating is the average rounded to one
 * decimal (the seed's 1-decimal shape); zero approved reviews → 0/0. */
async function recomputeProductRating(tx: Tx, productId: string): Promise<void> {
  const agg = await tx.review.aggregate({
    where: { productId, status: "APPROVED" },
    _avg: { rating: true },
    _count: { _all: true },
  });
  const count = agg._count._all;
  const rating = count === 0 || agg._avg.rating === null ? 0 : Math.round(agg._avg.rating * 10) / 10;
  await tx.product.update({
    where: { id: productId },
    data: { rating, reviewCount: count },
  });
}

/** Verified-purchase check (D13): the user has an order for this product
 * in DELIVERED status. OrderItem.productId is nullable (SetNull on product
 * delete), so a delivered order whose product was later deleted does not
 * count — the item no longer identifies the product. */
export async function hasDeliveredPurchase(userId: string, productId: string): Promise<boolean> {
  const order = await db.order.findFirst({
    where: { userId, status: "DELIVERED", items: { some: { productId } } },
    select: { id: true },
  });
  return order !== null;
}

/** Whether the PDP shows the write/edit form to this user: signed in AND
 * a verified purchaser. The check runs server-side; anyone else simply
 * sees no form (and no hint that one exists for purchasers). */
export async function canReviewProduct(productId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  return hasDeliveredPurchase(userId, productId);
}

/** The signed-in user's own review for a product (any status), for
 * pre-filling the edit form. Null when they have never reviewed it. */
export async function getMyReview(productId: string, userId: string) {
  return db.review.findFirst({
    where: { productId, userId },
    select: {
      id: true,
      rating: true,
      text: true,
      status: true,
      verifiedPurchase: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/** Create a review. The caller (route) enforces the spam rate limits;
 * this function enforces the business rules. A non-purchaser gets the
 * same NOT_FOUND as a missing product — eligibility is never leaked. */
export async function createReview(input: {
  productId: string;
  userId: string;
  rating: number;
  text?: string | null;
}): Promise<ReviewResult> {
  const product = await db.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: { id: true },
  });
  if (!product) {
    return { ok: false, code: "NOT_FOUND", error: "Product not found." };
  }
  if (!(await hasDeliveredPurchase(input.userId, input.productId))) {
    return { ok: false, code: "NOT_FOUND", error: "Product not found." };
  }
  const existing = await db.review.findFirst({
    where: { productId: input.productId, userId: input.userId },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      code: "ALREADY_EXISTS",
      error: "You have already reviewed this product. You can edit your review instead.",
    };
  }
  try {
    const review = await db.review.create({
      data: {
        productId: input.productId,
        userId: input.userId,
        rating: input.rating,
        text: input.text?.trim() ? input.text.trim() : null,
        status: "PENDING",
        verifiedPurchase: true,
      },
    });
    // PENDING reviews never count toward the aggregate, so no recompute.
    return { ok: true, review };
  } catch (error) {
    // Unique-race safety net: two concurrent creates for the same
    // (userId, productId) — the second hits the @@unique constraint.
    // Prisma P2002 (duck-typed by code, same as the catalogue mapper).
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      return {
        ok: false,
        code: "ALREADY_EXISTS",
        error: "You have already reviewed this product. You can edit your review instead.",
      };
    }
    throw error;
  }
}

/** Edit the author's own review. The edit returns the review to PENDING
 * moderation; when it was APPROVED, the aggregate is recomputed in the
 * same transaction (the review leaves the approved set until re-approved).
 * A customer may NOT delete their review in V1 — only edit it. */
export async function updateReview(input: {
  reviewId: string;
  userId: string;
  rating: number;
  text?: string | null;
}): Promise<ReviewResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.review.findFirst({
      where: { id: input.reviewId, userId: input.userId },
    });
    if (!existing) {
      return { ok: false, code: "NOT_FOUND", error: "Review not found." };
    }
    const wasApproved = existing.status === "APPROVED";
    const review = await tx.review.update({
      where: { id: existing.id },
      data: {
        rating: input.rating,
        text: input.text?.trim() ? input.text.trim() : null,
        status: "PENDING",
      },
    });
    if (wasApproved) await recomputeProductRating(tx, existing.productId);
    return { ok: true, review };
  });
}

/** Admin moderation: approve or reject. The status change and the
 * aggregate recompute happen in the same transaction. Approving an
 * already-approved review (or rejecting an already-rejected one) is a
 * no-op success — moderation is idempotent. */
export async function moderateReview(input: {
  reviewId: string;
  action: "APPROVED" | "REJECTED";
}): Promise<ReviewResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.review.findFirst({ where: { id: input.reviewId } });
    if (!existing) {
      return { ok: false, code: "NOT_FOUND", error: "Review not found." };
    }
    if (existing.status === input.action) {
      return { ok: true, review: existing };
    }
    const review = await tx.review.update({
      where: { id: existing.id },
      data: { status: input.action },
    });
    await recomputeProductRating(tx, existing.productId);
    return { ok: true, review };
  });
}

export interface ApprovedReviewRow {
  id: string;
  rating: number;
  text: string | null;
  verifiedPurchase: boolean;
  createdAt: Date;
  reviewerName: string;
}

export interface RatingDistribution {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

/** Approved reviews only, newest first, 10 per page, with the rating
 * distribution (counts per star, approved only) for the PDP summary. */
export async function listApprovedReviews(
  productId: string,
  page = 1
): Promise<{
  reviews: ApprovedReviewRow[];
  total: number;
  page: number;
  pageSize: number;
  distribution: RatingDistribution;
}> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const [rows, total, groups] = await Promise.all([
    db.review.findMany({
      where: { productId, status: "APPROVED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (safePage - 1) * REVIEW_PAGE_SIZE,
      take: REVIEW_PAGE_SIZE,
      include: { user: { select: { name: true } } },
    }),
    db.review.count({ where: { productId, status: "APPROVED" } }),
    db.review.groupBy({
      by: ["rating"],
      where: { productId, status: "APPROVED" },
      _count: { _all: true },
    }),
  ]);
  const distribution: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const g of groups) {
    if (g.rating >= 1 && g.rating <= 5) distribution[g.rating as 1 | 2 | 3 | 4 | 5] = g._count._all;
  }
  return {
    reviews: rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      text: r.text,
      verifiedPurchase: r.verifiedPurchase,
      createdAt: r.createdAt,
      reviewerName: formatReviewerName(r.user.name),
    })),
    total,
    page: safePage,
    pageSize: REVIEW_PAGE_SIZE,
    distribution,
  };
}

/** Admin moderation queue: all reviews, newest first, with product and
 * reviewer identity. Status filter is exact; an unknown value is ignored
 * (same as the admin orders paymentStatus filter). */
export async function listReviewsForAdmin(input: {
  status?: string;
  page?: number;
  perPage?: number;
}): Promise<{
  reviews: Array<{
    id: string;
    productId: string;
    productName: string;
    productSlug: string;
    userId: string;
    reviewerName: string;
    reviewerEmail: string;
    rating: number;
    text: string | null;
    status: string;
    verifiedPurchase: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>;
  total: number;
  page: number;
  perPage: number;
}> {
  const perPage = Math.min(100, Math.max(1, Math.floor(input.perPage ?? 25) || 25));
  const page = Math.max(1, Math.floor(input.page ?? 1) || 1);
  const status =
    input.status && (REVIEW_STATUSES as string[]).includes(input.status) ? input.status : undefined;
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    db.review.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        product: { select: { name: true, slug: true } },
        user: { select: { name: true, email: true } },
      },
    }),
    db.review.count({ where }),
  ]);
  return {
    reviews: rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      productName: r.product.name,
      productSlug: r.product.slug,
      userId: r.userId,
      reviewerName: formatReviewerName(r.user.name),
      reviewerEmail: r.user.email,
      rating: r.rating,
      text: r.text,
      status: r.status,
      verifiedPurchase: r.verifiedPurchase,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    total,
    page,
    perPage,
  };
}
