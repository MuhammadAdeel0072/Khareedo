// Route-level error boundary for the admin panel — a failed server render
// shows this instead of a blank page, with a retry that re-renders the
// segment. Never renders the error itself: stack traces and internal details
// must not leak into the admin UI.
"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AdminError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center p-4 py-24 text-center sm:p-6">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="h-7 w-7" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        We couldn&apos;t load this admin page. Please try again — if the problem continues,
        check the error monitoring dashboard.
      </p>
      <div className="mt-6 flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/admin">Back to Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
