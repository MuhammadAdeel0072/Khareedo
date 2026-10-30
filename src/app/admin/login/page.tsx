// Admin login page (FR-38).
import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin/admin-login-form";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Admin Login" };

export default async function AdminLoginPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) {
    const { db } = await import("@/lib/db");
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });
    if (user?.role === "ADMIN") redirect("/admin");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-md rounded-2xl" />}>
        <AdminLoginForm />
      </Suspense>
    </div>
  );
}
