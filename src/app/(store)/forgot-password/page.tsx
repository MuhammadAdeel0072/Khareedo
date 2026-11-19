// Forgot-password page (PR-09).
import { Suspense } from "react";
import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Forgot Password" };

export default function ForgotPasswordPage() {
  return (
    <div className="container-khd flex justify-center py-12">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-md rounded-2xl" />}>
        <ForgotPasswordForm />
      </Suspense>
    </div>
  );
}
