// Admin MFA setup page (PR-10). Outside the admin panel layout so an admin
// who has not yet enrolled (or whose session is not MFA-verified) can reach
// it. Role is still checked server-side; MFA verification is deliberately
// NOT required here — this is where MFA is set up.
import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth-guard";
import { getAdminMfaStatus } from "@/services/admin-mfa.service";
import { MfaSetupForm } from "@/components/admin/mfa-setup-form";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Set up MFA — Admin" };

export default async function AdminMfaSetupPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  if (user.role !== "ADMIN") redirect("/admin/login?error=Forbidden");
  // Initial status is rendered server-side so the client form does not need
  // a data-fetching effect; it re-fetches only after an action. enabledAt
  // is serialised to an ISO string for the client component.
  const initialStatus = await getAdminMfaStatus(user.id);
  const initialStatusJson = {
    ...initialStatus,
    enabledAt: initialStatus.enabledAt ? initialStatus.enabledAt.toISOString() : null,
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-8">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-lg rounded-2xl" />}>
        <MfaSetupForm initialStatus={initialStatusJson} />
      </Suspense>
    </div>
  );
}
