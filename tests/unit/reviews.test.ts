// Unit tests — product reviews (Phase 3, Chunk 9 — D13). Pure logic: no DB.
// Display-name formatting and the Zod schemas live here; the service
// invariants and HTTP mapping live in integration.reviews.test.ts and
// integration.review-routes.test.ts.
import { describe, expect, it } from "vitest";
import { formatReviewerName } from "@/services/reviews.service";
import { reviewSchema, reviewModerationSchema } from "@/lib/validation";

describe("formatReviewerName", () => {
  it("renders first name + last initial", () => {
    expect(formatReviewerName("Adeel Khan")).toBe("Adeel K.");
    expect(formatReviewerName("Maryam Nawaz Sharif")).toBe("Maryam N.");
  });
  it("renders a single name as-is", () => {
    expect(formatReviewerName("Adeel")).toBe("Adeel");
  });
  it("falls back to Customer when no name is stored", () => {
    expect(formatReviewerName(null)).toBe("Customer");
    expect(formatReviewerName(undefined)).toBe("Customer");
    expect(formatReviewerName("   ")).toBe("Customer");
  });
  it("trims and uppercases the initial", () => {
    expect(formatReviewerName("  adeel  khan  ")).toBe("adeel K.");
  });
});

describe("reviewSchema", () => {
  it("accepts ratings 1–5 and optional text", () => {
    expect(reviewSchema.parse({ rating: 1 })).toEqual({ rating: 1 });
    expect(reviewSchema.parse({ rating: 5, text: "Great product" })).toEqual({
      rating: 5,
      text: "Great product",
    });
    expect(reviewSchema.parse({ rating: "4" })).toEqual({ rating: 4 });
  });
  it("rejects ratings outside 1–5 and non-integers", () => {
    expect(reviewSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(reviewSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(reviewSchema.safeParse({ rating: 3.5 }).success).toBe(false);
    expect(reviewSchema.safeParse({}).success).toBe(false);
  });
  it("rejects text over 1000 characters", () => {
    expect(reviewSchema.safeParse({ rating: 5, text: "x".repeat(1001) }).success).toBe(false);
    expect(reviewSchema.safeParse({ rating: 5, text: "x".repeat(1000) }).success).toBe(true);
  });
});

describe("reviewModerationSchema", () => {
  it("accepts APPROVED and REJECTED only", () => {
    expect(reviewModerationSchema.parse({ action: "APPROVED" })).toEqual({ action: "APPROVED" });
    expect(reviewModerationSchema.parse({ action: "REJECTED" })).toEqual({ action: "REJECTED" });
    expect(reviewModerationSchema.safeParse({ action: "PENDING" }).success).toBe(false);
    expect(reviewModerationSchema.safeParse({}).success).toBe(false);
  });
});
