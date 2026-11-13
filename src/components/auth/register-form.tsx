"use client";

// Registration form (FR-02).
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { safeCallbackUrl } from "@/lib/auth-client";

export function RegisterForm({ googleEnabled }: { googleEnabled: boolean }) {
  const params = useSearchParams();
  const callbackUrl = safeCallbackUrl(params.get("callbackUrl"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, callbackUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrors(data.errors ?? { _: data.error ?? "Registration failed" });
        return;
      }
      const pendingUrl = new URL("/verify-email/pending", window.location.origin);
      pendingUrl.searchParams.set("email", email.trim().toLowerCase());
      pendingUrl.searchParams.set("callbackUrl", callbackUrl);
      window.location.assign(pendingUrl.toString());
    } catch {
      setErrors({ _: "Network error — please try again." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Create your account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Join Khareedo for faster checkout, order tracking and wishlist
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <Label htmlFor="name">Full name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ali Hassan"
              autoComplete="name"
              required
              className="mt-1.5 h-11"
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name && <p className="mt-1 text-xs font-medium text-destructive" role="alert">{errors.name}</p>}
          </div>
          <div>
            <Label htmlFor="reg-email">Email address</Label>
            <Input
              id="reg-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
              className="mt-1.5 h-11"
              aria-invalid={Boolean(errors.email)}
            />
            {errors.email && <p className="mt-1 text-xs font-medium text-destructive" role="alert">{errors.email}</p>}
          </div>
          <div>
            <Label htmlFor="reg-password">Password</Label>
            <Input
              id="reg-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1.5 h-11"
              aria-invalid={Boolean(errors.password)}
            />
            {errors.password ? (
              <p className="mt-1 text-xs font-medium text-destructive" role="alert">{errors.password}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Use 8+ characters with a mix of letters &amp; numbers</p>
            )}
          </div>

          {errors._ && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" role="alert">
              {errors._}
            </p>
          )}

          <Button type="submit" size="lg" className="h-11 w-full gap-2" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Create Account
          </Button>
        </form>

        {googleEnabled && (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <GoogleSignInButton
              callbackUrl={callbackUrl}
              className="h-11 w-full gap-2"
              disabled={loading}
              onStart={() => {
                setErrors({});
                setLoading(true);
              }}
              onError={(message) => {
                setErrors({ _: message });
                setLoading(false);
              }}
            />
          </div>
        )}

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="font-bold text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
