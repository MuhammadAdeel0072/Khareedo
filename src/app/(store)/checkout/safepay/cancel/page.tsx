import Link from "next/link";

export const dynamic = "force-dynamic";

export default function SafepayCancelPage() {
  return (
    <main className="container-khd max-w-2xl py-16">
      <section
        className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center text-amber-950 sm:p-8"
        aria-live="polite"
      >
        <h1 className="text-2xl font-bold">Payment checkout cancelled</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6">
          You cancelled checkout. Your payment has not been confirmed.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            className="rounded-md border px-4 py-2 text-sm font-medium"
            href="/account/orders"
          >
            View my orders
          </Link>
          <Link
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            href="/"
          >
            Continue shopping
          </Link>
        </div>
      </section>
    </main>
  );
}
