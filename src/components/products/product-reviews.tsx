// Product reviews section (Phase 3, Chunk 9 — D13). Approved reviews
// only, newest first, 10 per page. The summary (average + count) reads
// the aggregated Product.rating/reviewCount; the distribution counts
// approved reviews per star. Pagination rides the `reviewsPage` query
// param so it stays server-rendered. The write/edit form renders ONLY
// for a signed-in verified purchaser — anyone else sees no form and no
// hint that one exists for purchasers.
import Link from "next/link";
import { BadgeCheck, Star } from "lucide-react";
import { RatingStars } from "@/components/products/rating-stars";
import { ReviewForm } from "@/components/products/review-form";
import {
  canReviewProduct,
  getMyReview,
  listApprovedReviews,
} from "@/services/reviews.service";
import { formatDate } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";

export async function ProductReviewsSection({
  productId,
  productSlug,
  rating,
  reviewCount,
  userId,
  page,
}: {
  productId: string;
  productSlug: string;
  rating: number;
  reviewCount: number;
  userId: string | null;
  page: number;
}) {
  const [listed, myReview, eligible] = await Promise.all([
    listApprovedReviews(productId, page),
    userId ? getMyReview(productId, userId) : Promise.resolve(null),
    userId ? canReviewProduct(productId, userId) : Promise.resolve(false),
  ]);
  const totalPages = Math.max(1, Math.ceil(listed.total / listed.pageSize));
  const showForm = eligible;

  return (
    <section className="mt-14" aria-label="Customer reviews" data-reviews-section>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-xl font-extrabold tracking-tight">Customer Reviews</h2>
        {reviewCount > 0 && (
          <span className="text-sm text-muted-foreground">
            {rating.toFixed(1)} out of 5 · {reviewCount} review{reviewCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Summary: average + distribution (approved reviews only). */}
        <div className="rounded-xl border p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <span className="text-4xl font-extrabold">{rating.toFixed(1)}</span>
            <div>
              <RatingStars rating={rating} size="md" />
              <p className="mt-1 text-xs text-muted-foreground">
                {reviewCount === 0
                  ? "No reviews yet"
                  : `${reviewCount} verified review${reviewCount === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>
          <Separator className="my-4" />
          <div className="space-y-2" aria-label="Rating distribution">
            {[5, 4, 3, 2, 1].map((stars) => {
              const count = listed.distribution[stars as 1 | 2 | 3 | 4 | 5];
              const pct = listed.total > 0 ? Math.round((count / listed.total) * 100) : 0;
              return (
                <div key={stars} className="flex items-center gap-2 text-xs">
                  <span className="flex w-8 shrink-0 items-center gap-0.5 font-medium">
                    {stars}
                    <Star className="h-3 w-3 fill-star text-star" aria-hidden="true" />
                  </span>
                  <div
                    className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${stars} star reviews: ${count}`}
                  >
                    <div className="h-full rounded-full bg-star" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-8 shrink-0 text-right text-muted-foreground">{count}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          {showForm && (
            <div className="mb-6">
              <ReviewForm
                productId={productId}
                existing={myReview ? { id: myReview.id, rating: myReview.rating, text: myReview.text } : null}
              />
            </div>
          )}

          {listed.reviews.length === 0 ? (
            <p className="rounded-lg border p-6 text-sm text-muted-foreground">
              {myReview
                ? "Your review is awaiting moderation and will appear here once approved."
                : "No reviews yet. Verified purchasers can share their experience after delivery."}
            </p>
          ) : (
            <ul className="space-y-4">
              {listed.reviews.map((r) => (
                <li key={r.id} className="rounded-xl border p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <RatingStars rating={r.rating} />
                    <span className="text-sm font-semibold">{r.reviewerName}</span>
                    {r.verifiedPurchase && (
                      <span className="flex items-center gap-1 text-xs font-medium text-primary">
                        <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        Verified purchase
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>
                  </div>
                  {r.text && <p className="mt-2 text-sm leading-6 text-foreground/85">{r.text}</p>}
                </li>
              ))}
            </ul>
          )}

          {totalPages > 1 && (
            <nav className="mt-6 flex items-center justify-center gap-1" aria-label="Review pages">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={p === 1 ? `/product/${productSlug}` : `/product/${productSlug}?reviewsPage=${p}`}
                  aria-current={listed.page === p ? "page" : undefined}
                  className={
                    listed.page === p
                      ? "flex h-9 min-w-9 items-center justify-center rounded-md bg-primary px-2 text-sm font-semibold text-primary-foreground"
                      : "flex h-9 min-w-9 items-center justify-center rounded-md border px-2 text-sm font-medium hover:bg-accent"
                  }
                >
                  {p}
                </Link>
              ))}
            </nav>
          )}
        </div>
      </div>
    </section>
  );
}
