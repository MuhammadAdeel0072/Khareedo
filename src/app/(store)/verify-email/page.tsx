import type { Metadata } from "next";
import Link from "next/link";
import { verifyEmailToken } from "@/services/email-verification.service";

export const metadata: Metadata = { title: "Verify Email" };
export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawToken = params.token;
  const token = typeof rawToken === "string" ? rawToken : "";
  const verified = await verifyEmailToken(token);

  return (
    <div className="container-khd flex justify-center py-12">
      <section className="w-full max-w-lg rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <h1 className="text-2xl font-extrabold tracking-tight">
          {verified ? "Email verified" : "Verification link unavailable"}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          {verified
            ? "Your email is verified. You can now sign in to your Khareedo account."
            : "This link is invalid, expired, or has already been used. Request a new verification email to continue."}
        </p>
        <Link
          href={verified ? "/login" : "/verify-email/pending"}
          className="mt-6 inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {verified ? "Sign in" : "Request a new link"}
        </Link>
      </section>
    </div>
  );
}
