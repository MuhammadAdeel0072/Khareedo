// Review write/edit form (Phase 3, Chunk 9 — D13). Shown only to a
// signed-in verified purchaser (the parent section decides). Create posts
// to /api/products/[id]/reviews; editing an existing review PATCHes
// /api/account/reviews/[id] and returns it to pending moderation.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function ReviewForm({
  productId,
  existing,
}: {
  productId: string;
  existing: { id: string; rating: number; text: string | null } | null;
}) {
  const router = useRouter();
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState(existing?.text ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (rating < 1 || rating > 5) {
      toast.error("Please choose a star rating.");
      return;
    }
    setBusy(true);
    try {
      const url = existing
        ? `/api/account/reviews/${existing.id}`
        : `/api/products/${productId}/reviews`;
      const res = await fetch(url, {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, text: text.trim() || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast.error(data?.error ?? "Could not submit your review. Please try again.");
        return;
      }
      toast.success(
        existing
          ? "Your review was updated and is awaiting moderation."
          : "Thank you! Your review is awaiting moderation."
      );
      router.refresh();
    } catch {
      toast.error("Could not submit your review. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border p-4 sm:p-5">
      <h3 className="text-base font-bold">{existing ? "Edit your review" : "Write a review"}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {existing
          ? "Edits return your review to pending moderation."
          : "Only verified purchasers can review. Your review is checked by our team before it appears."}
      </p>
      <div className="mt-3 flex items-center gap-1" role="radiogroup" aria-label="Your rating">
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={rating === i}
            aria-label={`${i} star${i === 1 ? "" : "s"}`}
            disabled={busy}
            onClick={() => setRating(i)}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(0)}
            className="rounded p-0.5 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Star
              className={cn(
                "h-7 w-7",
                (hover || rating) >= i ? "fill-star text-star" : "fill-muted text-muted-foreground/30"
              )}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={1000}
        rows={3}
        placeholder="Share what you liked (optional)"
        aria-label="Review text (optional)"
        className="mt-3"
        disabled={busy}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{text.length}/1000</span>
        <Button onClick={submit} disabled={busy}>
          {busy ? "Submitting…" : existing ? "Update review" : "Submit review"}
        </Button>
      </div>
    </div>
  );
}
