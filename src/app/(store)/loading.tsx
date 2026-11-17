// Route-level loading state for the storefront — shown while a page's server
// data is loading (navigation, filters, pagination). Matches the layout's
// container and card rhythm so the transition feels like content arriving,
// not a blank page.
import { Skeleton } from "@/components/ui/skeleton";

export default function StoreLoading() {
  return (
    <div className="container-khd py-6" aria-label="Loading page content">
      <Skeleton className="h-8 w-56 rounded-lg" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full rounded-lg" />
      <Skeleton className="mt-6 h-64 w-full rounded-2xl sm:h-80" />
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border bg-card">
            <Skeleton className="aspect-square w-full rounded-none" />
            <div className="space-y-2 p-3.5">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-2/3 rounded" />
              <Skeleton className="mt-1 h-10 w-full rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
