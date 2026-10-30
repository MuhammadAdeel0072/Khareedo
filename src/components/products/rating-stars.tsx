// Star rating display (D-08 — display-only ratings).
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

export function RatingStars({
  rating,
  reviewCount,
  size = "sm",
  className,
}: {
  rating: number;
  reviewCount?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const rounded = Math.round(rating * 2) / 2;
  return (
    <div
      className={cn("flex items-center gap-1", className)}
      aria-label={`Rated ${rating.toFixed(1)} out of 5${reviewCount !== undefined ? ` from ${reviewCount} reviews` : ""}`}
    >
      <div className="flex" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            className={cn(
              size === "sm" ? "h-3.5 w-3.5" : "h-4.5 w-4.5",
              i <= rounded
                ? "fill-amber-400 text-amber-400"
                : i - 0.5 === rounded
                  ? "fill-amber-400/50 text-amber-400"
                  : "fill-muted text-muted-foreground/30"
            )}
          />
        ))}
      </div>
      <span className={cn("font-medium text-muted-foreground", size === "sm" ? "text-xs" : "text-sm")}>
        {rating.toFixed(1)}
        {reviewCount !== undefined && ` (${reviewCount})`}
      </span>
    </div>
  );
}
