// Admin MFA verification page (PR-10). Shown after an admin signs in with
// their password when MFA is enabled but this session has not verified it
// yet. Outside the admin panel layout so it is reachable before MFA
// verification; role is still checked server-side.
import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth-guard";
import { MfaVerifyForm } from "@/components/admin/mfa-verify-form";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Two-factor authentication — Admin" };

export default async function AdminMfaVerifyPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  if (user.role !== "ADMIN") redirect("/admin/login?error=Forbidden");

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-md rounded-2xl" />}>
        <MfaVerifyForm />
      </Suspense>
    </div>
  );
}
