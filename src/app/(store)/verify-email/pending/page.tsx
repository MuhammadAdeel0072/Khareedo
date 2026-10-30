import type { Metadata } from "next";
import Link from "next/link";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";

export const metadata: Metadata = { title: "Verify Your Email" };

export default function VerificationPendingPage() {
  return (
    <div className="container-khd flex justify-center py-12">
      <section className="w-full max-w-lg rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <h1 className="text-2xl font-extrabold tracking-tight">Check your email</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          If an eligible account exists for the submitted address, we&apos;ve sent a verification link.
          The link expires after 24 hours.
        </p>
        <ResendVerificationForm />
        <p className="mt-5 text-sm text-muted-foreground">
          Already verified?{" "}
          <Link href="/login" className="font-bold text-primary hover:underline">Sign in</Link>
        </p>
      </section>
    </div>
  );
}
