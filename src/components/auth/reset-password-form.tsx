"use client";

// Reset-password form (PR-09). Redeems the single-use token from the reset
// link and sets a new password. The token is never displayed or logged.
import { useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (password !== confirmPassword) {
      setError("The two passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string; errors?: Record<string, string> };
      if (!res.ok || !data.ok) {
        setError(data.errors?.password ?? data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setMessage(data.message ?? "Your password has been reset.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Choose a new password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your new password must be at least 8 characters.
        </p>

        {!token && (
          <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" role="alert">
            This reset link is missing its token. Please request a new password reset link.
          </p>
        )}

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1.5 h-11"
            />
          </div>
          <div>
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1.5 h-11"
            />
          </div>

          {message && (
            <p className="rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-foreground" role="status">
              {message}{" "}
              <Link href="/login" className="font-bold text-primary hover:underline">
                Sign in
              </Link>
            </p>
          )}
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="h-11 w-full gap-2" disabled={loading || !token}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Reset password
          </Button>
        </form>
      </div>
    </div>
  );
}
