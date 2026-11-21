// Admin review moderation queue (Phase 3, Chunk 9 — D13). Reviews are
// pre-moderated: nothing appears on the storefront until an admin approves
// it here. URL is the single source of truth: status and page live in the
// query string. Role + MFA are enforced by the admin panel layout.
import Link from "next/link";
import { listReviewsForAdmin, REVIEW_STATUSES } from "@/services/reviews.service";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReviewModerationActions } from "@/components/admin/review-moderation-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reviews · Admin" };

function firstParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function AdminReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = firstParam(params.status).trim();
  const page = Number(firstParam(params.page) || "1") || 1;

  const result = await listReviewsForAdmin({ status: status || undefined, page, perPage: 25 });
  const totalPages = Math.max(1, Math.ceil(result.total / result.perPage));
  const pendingCount = status === "PENDING" ? result.total : null;

  const buildUrl = (parts: { status?: string; page?: number }) => {
    const sp = new URLSearchParams();
    const effectiveStatus = parts.status !== undefined ? parts.status : status;
    if (effectiveStatus) sp.set("status", effectiveStatus);
    if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
    const qs = sp.toString();
    return qs ? `/admin/reviews?${qs}` : "/admin/reviews";
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Reviews</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {pendingCount !== null
              ? `${result.total} review${result.total === 1 ? "" : "s"} awaiting moderation.`
              : `${result.total} review${result.total === 1 ? "" : "s"} match this filter.`}{" "}
            Approved reviews appear on the product page; rejected ones never do.
          </p>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {["", ...REVIEW_STATUSES].map((value) => {
          const active = (value || "") === status;
          const label = value === "" ? "All" : value === "PENDING" ? "Pending" : value === "APPROVED" ? "Approved" : "Rejected";
          return (
            <Button key={value || "all"} variant={active ? "default" : "outline"} asChild>
              <Link href={buildUrl({ status: value, page: 1 })}>{label}</Link>
            </Button>
          );
        })}
        {status && (
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/reviews">Clear</Link>
          </Button>
        )}
      </div>

      {result.reviews.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          No reviews match this filter. New reviews from verified purchasers will appear here for moderation.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-160 text-left text-sm">
            <thead className="bg-muted/60">
              <tr>
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Product</th>
                <th className="px-3 py-2 font-semibold">Reviewer</th>
                <th className="px-3 py-2 font-semibold">Rating</th>
                <th className="px-3 py-2 font-semibold">Review</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.reviews.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDate(r.createdAt)}</td>
                  <td className="px-3 py-2">
                    <Link href={`/product/${r.productSlug}`} className="font-medium hover:underline">
                      {r.productName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{r.reviewerName}</span>
                    <span className="block text-xs text-muted-foreground">{r.reviewerEmail}</span>
                    {r.verifiedPurchase && (
                      <span className="mt-0.5 block text-xs font-medium text-primary">Verified purchase</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-semibold">{r.rating} / 5</td>
                  <td className="max-w-80 px-3 py-2 text-muted-foreground">{r.text ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={r.status === "APPROVED" ? "default" : r.status === "REJECTED" ? "destructive" : "outline"}
                    >
                      {r.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {r.status === "PENDING" ? (
                      <ReviewModerationActions reviewId={r.id} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center gap-2">
          {page > 1 && (
            <Button variant="outline" asChild>
              <Link href={buildUrl({ page: page - 1 })}>Previous</Link>
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Button variant="outline" asChild>
              <Link href={buildUrl({ page: page + 1 })}>Next</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
