// Admin layout — role-guarded shell (FR-38, NFR-12). The proxy redirects
// non-admins; this layout additionally re-verifies the role server-side.
import { redirect } from "next/navigation";
import { getRequestSession, getSessionUser, isMfaVerifiedForSession } from "@/lib/auth-guard";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { getPendingOrdersCount } from "@/services/reports.service";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequestSession();
  if (!session?.user?.id) redirect("/admin/login");
  // Role re-check and the public pending-orders badge are independent reads.
  const [user, pendingOrders] = await Promise.all([
    getSessionUser(),
    getPendingOrdersCount(),
  ]);
  if (!user || user.role !== "ADMIN") redirect("/admin/login?error=Forbidden");
  // MFA enforcement (PR-10): an admin who has not enrolled is sent to setup;
  // an admin whose session has not verified MFA is sent to verify. The MFA
  // pages live outside this layout so they stay reachable.
  if (!user.mfaEnabledAt) redirect("/admin/mfa/setup");
  if (
    !isMfaVerifiedForSession(
      user.mfaLastVerifiedAt,
      session?.iat,
      user.mfaLastVerifiedSessionId,
      user.sessionSid
    )
  ) {
    redirect("/admin/mfa/verify");
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <div className="sticky top-0 z-40 lg:sticky lg:top-0 lg:h-screen">
        <AdminSidebar pendingOrders={pendingOrders} />
      </div>
      <main className="min-w-0 flex-1 bg-muted/40">{children}</main>
    </div>
  );
}
