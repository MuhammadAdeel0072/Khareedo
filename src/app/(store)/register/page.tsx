// Registration page (FR-02).
import { Suspense } from "react";
import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";
import { Skeleton } from "@/components/ui/skeleton";
import { isGoogleEnabled } from "@/lib/auth";

export const metadata: Metadata = { title: "Create Account" };

export default function RegisterPage() {
  return (
    <div className="container-khd flex justify-center py-12">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-md rounded-2xl" />}>
        <RegisterForm googleEnabled={isGoogleEnabled()} />
      </Suspense>
    </div>
  );
}
