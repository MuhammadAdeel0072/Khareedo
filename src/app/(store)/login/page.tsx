// Login page (FR-02/03).
import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { Skeleton } from "@/components/ui/skeleton";
import { isGoogleEnabled } from "@/lib/auth";
import { getCachedSettings } from "@/services/settings.service";

export const metadata: Metadata = { title: "Sign In" };

export default async function LoginPage() {
  const settings = await getCachedSettings();
  return (
    <div className="container-khd flex justify-center py-12">
      <Suspense fallback={<Skeleton className="h-96 w-full max-w-md rounded-2xl" />}>
        <LoginForm googleEnabled={isGoogleEnabled()} whatsappNumber={settings.whatsapp_number} />
      </Suspense>
    </div>
  );
}
