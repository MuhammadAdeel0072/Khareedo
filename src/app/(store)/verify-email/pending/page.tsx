import type { Metadata } from "next";
import Link from "next/link";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { emailSchema } from "@/lib/validation";
import { safeCallbackUrl } from "@/lib/auth-client";

export const metadata: Metadata = {
  title: "Verify Your Email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function VerificationPendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawEmail = params.email;
  const parsedEmail = typeof rawEmail === "string" ? emailSchema.safeParse(rawEmail) : null;
  const email = parsedEmail?.success ? parsedEmail.data : undefined;
  const rawCallback = params.callbackUrl;
  const callbackUrl = safeCallbackUrl(typeof rawCallback === "string" ? rawCallback : null);

  return (
    <div className="container-khd flex justify-center py-12">
      <section className="w-full max-w-lg rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <h1 className="text-2xl font-extrabold tracking-tight">Check your email</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          If an eligible account exists for this address, we&apos;ve sent a verification link.
          {email ? <> Check the inbox for <span className="font-medium text-foreground">{email}</span> to activate your Khareedo account.</> : <> Please check your inbox to activate your Khareedo account.</>}
          {" "}The link expires after 24 hours.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          If you don&apos;t see it, check your Spam or Junk folder.
        </p>
        <ResendVerificationForm email={email} callbackUrl={callbackUrl} />
        <p className="mt-4 text-sm text-muted-foreground">
          Entered the wrong address?{" "}
          <Link
            href={`/register?callbackUrl=${encodeURIComponent(callbackUrl)}`}
            className="font-bold text-primary hover:underline"
          >
            Create an account with a different email
          </Link>
          . This will not change another account&apos;s email address.
        </p>
        <p className="mt-5 text-sm text-muted-foreground">
          Already verified?{" "}
          <Link href="/login" className="font-bold text-primary hover:underline">Sign in</Link>
        </p>
      </section>
    </div>
  );
}
