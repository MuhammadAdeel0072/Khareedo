import type { Metadata } from "next";
import { VerifyEmailClient } from "@/components/auth/verify-email-client";
import { safeCallbackUrl } from "@/lib/auth-client";

export const metadata: Metadata = {
  title: "Verify Email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawToken = params.token;
  const token = typeof rawToken === "string" ? rawToken : "";
  const rawCallback = params.callbackUrl;
  const callbackUrl = safeCallbackUrl(typeof rawCallback === "string" ? rawCallback : null);

  return (
    <div className="container-khd flex justify-center py-12">
      <section className="w-full max-w-lg rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <VerifyEmailClient token={token} callbackUrl={callbackUrl} />
      </section>
    </div>
  );
}
