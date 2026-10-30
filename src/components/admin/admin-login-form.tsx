"use client";

// Admin login — same credential provider; role enforced by proxy + layout (FR-38).
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Image from "next/image";
import { Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminLoginForm() {
  const params = useSearchParams();
  const forbidden = params.get("error") === "Forbidden";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    forbidden ? "This account does not have administrator access." : null
  );
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await signIn("credentials", { email, password, redirect: false });
      if (!res?.ok) {
        setError("Incorrect email or password.");
        return;
      }
      // Role is re-verified by the proxy; if not admin this navigation bounces back
      // (full navigation avoids the session-cookie vs client-router race)
      window.location.assign("/admin");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-2">
          <Image
            src="/images/khareedo-wordmark.png"
            alt="Khareedo"
            width={217}
            height={48}
            className="h-7 w-auto"
          />
          <h1 className="text-xl font-extrabold tracking-tight">Admin Panel</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Restricted area — authorised administrators only
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <Label htmlFor="admin-email">Email address</Label>
            <Input
              id="admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@khareedo.pk"
              autoComplete="email"
              required
              className="mt-1.5 h-11"
            />
          </div>
          <div>
            <Label htmlFor="admin-password">Password</Label>
            <Input
              id="admin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              className="mt-1.5 h-11"
            />
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="h-11 w-full gap-2" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            Sign In to Admin
          </Button>
        </form>
      </div>
    </div>
  );
}
