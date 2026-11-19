// Admin login page (FR-38).
import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin/admin-login-form";
import { getSessionUser } from "@/lib/auth-guard";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Admin Login" };

export default async function AdminLoginPage() {
  // Read the session through the auth guard (PR-25), not the raw session:
  // the guard returns null for a password-reset-invalidated session, so an
  // admin whose session was invalidated sees the login form and can sign in
  // fresh. The old code used getServerSession + a role lookup, which still
  // saw the (cryptographically valid) invalidated session and redirected to
  // /admin — but the panel layout enforces the guard and sent the admin
  // straight back here, looping forever.
  const user = await getSessionUser();
  if (user?.role === "ADMIN") redirect("/admin");

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-md rounded-2xl" />}>
        <AdminLoginForm />
      </Suspense>
    </div>
  );
}
