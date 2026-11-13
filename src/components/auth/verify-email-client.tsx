"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeCallbackUrl } from "@/lib/auth-client";

export function VerifyEmailClient({
  token,
  callbackUrl,
}: {
  token: string;
  callbackUrl: string;
}) {
  const started = useRef(false);
  const [status, setStatus] = useState<"verifying" | "failed">(
    token ? "verifying" : "failed"
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    window.history.replaceState(null, "", "/verify-email");
    if (!token) return;

    void signIn("email-verification", {
      token,
      callbackUrl: safeCallbackUrl(callbackUrl),
      redirect: false,
    })
      .then((result) => {
        if (result?.ok) {
          window.location.assign(safeCallbackUrl(callbackUrl));
          return;
        }
        setStatus("failed");
      })
      .catch(() => setStatus("failed"));
  }, [token, callbackUrl]);

  if (status === "verifying") {
    return (
      <>
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Verifying your email</h1>
        <p className="mt-3 text-sm text-muted-foreground" role="status" aria-live="polite">
          Please wait while we securely verify your address and sign you in.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-extrabold tracking-tight">Verification link unavailable</h1>
      <p className="mt-3 text-sm text-muted-foreground" role="alert">
        This link is invalid, expired, or has already been used. If you have already verified your email, sign in; otherwise request a new link.
      </p>
      <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
        <Button asChild className="h-11">
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link href="/verify-email/pending">Request a new link</Link>
        </Button>
      </div>
    </>
  );
}
