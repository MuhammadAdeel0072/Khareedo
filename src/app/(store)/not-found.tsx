import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container-khd flex flex-col items-center justify-center py-24 text-center">
      <p className="text-7xl font-extrabold text-primary/20">404</p>
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Back to Home
      </Link>
    </div>
  );
}
