"use client";

import { useEffect, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ResendVerificationForm({
  email: initialEmail,
  callbackUrl,
}: {
  email?: string;
  callbackUrl: string;
}) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (loading || cooldown > 0) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, callbackUrl }),
      });
      const data = await response.json();
      if (response.status === 429) {
        setCooldown(Number(data.retryAfterSec) || 60);
      }
      if (response.status === 503) {
        setError(data.error ?? "Email verification is not configured. Please contact the store administrator.");
        return;
      }
      if (!response.ok || !data.ok) {
        setError(data.error ?? "Unable to process the request. Please try again later.");
        return;
      }
      setMessage(data.message);
      setCooldown(60);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3">
      {initialEmail ? (
        <p className="text-sm text-muted-foreground">
          Verification email for <span className="font-medium text-foreground">{initialEmail}</span>
        </p>
      ) : (
        <div className="text-left">
          <Label htmlFor="verification-email">Email address</Label>
          <Input
            id="verification-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1.5 h-11"
          />
        </div>
      )}
      {message && <p className="text-sm text-emerald-700" role="status">{message}</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button
        type="submit"
        className="h-11 w-full gap-2"
        disabled={loading || cooldown > 0}
        aria-busy={loading}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
        {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend verification email"}
      </Button>
    </form>
  );
}
