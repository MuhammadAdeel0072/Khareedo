"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function GoogleSignInButton({
  callbackUrl,
  disabled = false,
  className,
  onStart,
  onError,
}: {
  callbackUrl: string;
  disabled?: boolean;
  className?: string;
  onStart?: () => void;
  onError?: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);

  async function startGoogleSignIn() {
    if (loading || disabled) return;
    setLoading(true);
    onStart?.();
    try {
      const result = await signIn("google", { callbackUrl });
      if (result?.error) {
        onError?.("Google sign-in was not completed. You can try again or use email and password.");
        setLoading(false);
      }
    } catch {
      onError?.("Could not start Google sign-in. Please try again.");
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className={className}
      disabled={disabled || loading}
      aria-busy={loading}
      onClick={startGoogleSignIn}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden="true" focusable="false">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18A10.96 10.96 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
        </svg>
      )}
      Continue with Google
    </Button>
  );
}
