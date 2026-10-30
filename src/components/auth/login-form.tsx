"use client";

// Login form — credentials + Google (FR-02/03, BR-03).
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WhatsAppIcon } from "@/components/layout/whatsapp-icon";
import { safeCallbackUrl } from "@/lib/auth-client";

export function LoginForm() {
  const params = useSearchParams();
  const callbackUrl = safeCallbackUrl(params.get("callbackUrl"));
  const providerError = params.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const providerErrorMessage =
    providerError === "OAuthAccountNotLinked"
      ? "An account already uses this email. Sign in with email and password; Google accounts are not linked automatically."
      : providerError === "GoogleEmailNotVerified"
        ? "Google did not confirm this email address. Try another sign-in method."
        : providerError
          ? "Google sign-in was cancelled or could not be completed. Please try again."
          : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (!res?.ok) {
        setError("Incorrect email or password. Please try again.");
        return;
      }
      toast.success("Welcome back!");
      // Full navigation — router.push + refresh races the session cookie against
      // the route guard on first /account load (intermittent bounce to /login)
      window.location.assign(callbackUrl);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in to your Khareedo account
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
              className="mt-1.5 h-11"
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              className="mt-1.5 h-11"
            />
          </div>

          {(error || providerErrorMessage) && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" role="alert">
              {error ?? providerErrorMessage}
            </p>
          )}

          <Button type="submit" size="lg" className="h-11 w-full gap-2" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            Sign In
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          New to Khareedo?{" "}
          <Link href={`/register?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="font-bold text-primary hover:underline">
            Create an account
          </Link>
        </p>
      </div>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Need assistance? Message us on{" "}
        <a
          href="https://wa.me/923001234567"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 font-medium text-[#128C4B] hover:underline"
        >
          <WhatsAppIcon className="h-3 w-3" /> WhatsApp
        </a>
      </p>
    </div>
  );
}
