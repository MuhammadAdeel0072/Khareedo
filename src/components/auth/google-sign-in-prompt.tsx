"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";

const DISMISSED_KEY = "khareedo-google-signin-prompt-dismissed";

export function GoogleSignInPrompt() {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.sessionStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      dismissed = false;
    }
    const timer = window.setTimeout(() => setVisible(!dismissed), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // The message can still be dismissed for this render if storage is unavailable.
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <aside
      aria-label="Google sign-in"
      className="flex max-w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-2 shadow-sm sm:gap-3"
    >
      <p className="hidden text-xs text-muted-foreground min-[420px]:block">
        Sign in faster with Google
      </p>
      <GoogleSignInButton
        callbackUrl="/"
        className="h-9 px-3 text-xs"
        onStart={dismiss}
        onError={(message) => {
          setVisible(true);
          setError(message);
        }}
      />
      <button
        type="button"
        aria-label="Dismiss Google sign-in message"
        title="Dismiss"
        onClick={dismiss}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      {error && <span className="max-w-36 text-xs text-destructive sm:max-w-52" role="alert">{error}</span>}
    </aside>
  );
}
