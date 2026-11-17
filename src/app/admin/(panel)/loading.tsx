// Route-level loading state for the admin panel — stat cards + table skeleton,
// matching the dashboard's spacing.
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminLoading() {
  return (
    <div className="p-4 sm:p-6" aria-label="Loading admin page">
      <Skeleton className="h-7 w-44 rounded-lg" />
      <Skeleton className="mt-2 h-4 w-72 max-w-full rounded-lg" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-4 h-80 rounded-xl" />
    </div>
  );
}
