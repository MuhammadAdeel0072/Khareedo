"use client";

// Admin MFA verification (PR-10). Shown after an admin signs in with their
// password when MFA is enabled but this session has not verified it yet.
// Accepts a 6-digit authenticator code or a recovery code.
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeCallbackUrl } from "@/lib/auth-client";

export function MfaVerifyForm() {
  const router = useRouter();
  const params = useSearchParams();
  // The callbackUrl comes from the query string, so it must be validated:
  // an unvalidated value here was an open redirect (Phase 2, area C —
  // /admin/mfa/verify?callbackUrl=https://evil.example.com would have
  // sent the admin away after a successful verification).
  const callbackUrl = safeCallbackUrl(params.get("callbackUrl"), "/admin");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/admin/mfa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; code?: string };
      if (!res.ok || data.ok === false) {
        if (data.code === "MFA_ENROLLMENT_REQUIRED") {
          router.push("/admin/mfa/setup");
          return;
        }
        setError(data.error ?? "That code is not valid. Please try again.");
        return;
      }
      router.push(callbackUrl);
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
          <ShieldCheck className="h-5 w-5 text-green-600" />
          <h1 className="text-xl font-extrabold tracking-tight">Two-factor authentication</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the 6-digit code from your authenticator app. Lost your authenticator? Use one of your recovery
          codes instead.
        </p>
        {error && <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <Label htmlFor="mfa-code">Authenticator code or recovery code</Label>
            <Input
              id="mfa-code"
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456 or XXXX-XXXXX"
              autoComplete="one-time-code"
              required
              className="mt-1.5 h-11"
            />
          </div>
          <Button type="submit" className="h-11 w-full" disabled={loading || code.trim().length < 6}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          Lost both your authenticator and your recovery codes? Contact the operator — MFA can only be reset
          server-side (see the break-glass procedure in the admin docs).
        </p>
      </div>
    </div>
  );
}
