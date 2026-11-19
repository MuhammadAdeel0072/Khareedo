"use client";

// Admin MFA setup — enrollment, activation, replacement, recovery codes,
// disablement (PR-10). Steps: (1) start enrollment (QR code + manual key),
// (2) verify the first TOTP code to activate, (3) save the recovery codes
// (shown once). When MFA is already enabled this form shows status and
// offers recovery-code regeneration, authenticator replacement (requires
// the current password and a code from the current authenticator; the old
// authenticator keeps working until the new one is verified), and
// disablement (requires reauthentication).
import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type MfaStatus = {
  enrolled: boolean;
  enabled: boolean;
  enabledAt: string | null;
  hasRecoveryCodes: boolean;
  unusedRecoveryCodes: number;
};

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { ok: boolean; error?: string; code?: string };
  if (!res.ok || data.ok === false) {
    const error = new Error(data.error ?? "Something went wrong. Please try again.") as Error & { code?: string };
    error.code = data.code;
    throw error;
  }
  return data;
}

export function MfaSetupForm({ initialStatus }: { initialStatus: MfaStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState<MfaStatus | null>(initialStatus);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [savedRecoveryCodes, setSavedRecoveryCodes] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Replacement flow (active MFA only): reauthentication inputs and the new
  // pending secret's QR code. The old authenticator keeps working until
  // the new one is verified via activate.
  const [replacePassword, setReplacePassword] = useState("");
  const [replaceCode, setReplaceCode] = useState("");
  const [replacementQr, setReplacementQr] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState<string | null>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ status: MfaStatus }>("/api/admin/mfa/status");
      setStatus(data.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load MFA status.");
    } finally {
      setLoading(false);
    }
  }

  async function startEnrollment() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const data = await api<{ qrCodeDataUrl: string; manualKey: string }>("/api/admin/mfa/setup", {});
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setManualKey(data.manualKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start MFA setup.");
    } finally {
      setBusy(false);
    }
  }

  async function activate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{ recoveryCodes: string[] }>("/api/admin/mfa/activate", { code });
      setRecoveryCodes(data.recoveryCodes);
      setSavedRecoveryCodes(false);
      setReplacementQr(null);
      setReplacementKey(null);
      setReplacePassword("");
      setReplaceCode("");
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not activate MFA.");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateCodes() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const data = await api<{ recoveryCodes: string[] }>("/api/admin/mfa/recovery-codes", {});
      setRecoveryCodes(data.recoveryCodes);
      setSavedRecoveryCodes(false);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not regenerate recovery codes.");
    } finally {
      setBusy(false);
    }
  }

  async function disableMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api("/api/admin/mfa/disable", { password, code });
      setNotice("Multi-factor authentication has been disabled.");
      setPassword("");
      setCode("");
      setQrCodeDataUrl(null);
      setManualKey(null);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disable MFA.");
    } finally {
      setBusy(false);
    }
  }

  async function startReplacement(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const data = await api<{ qrCodeDataUrl: string; manualKey: string }>("/api/admin/mfa/replace", {
        password: replacePassword,
        code: replaceCode,
      });
      setReplacementQr(data.qrCodeDataUrl);
      setReplacementKey(data.manualKey);
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start replacement.");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading MFA status…
      </div>
    );
  }

  // Recovery codes are shown once, right after activation or regeneration.
  // The admin must confirm they saved them before continuing.
  if (recoveryCodes) {
    return (
      <div className="w-full max-w-lg space-y-4">
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-green-600" />
            <h2 className="text-lg font-bold">Save your recovery codes</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            These codes are the only way back in if you lose your authenticator app. Each code works once.
            <strong> Save them somewhere safe now — they will never be shown again.</strong>
          </p>
          <div className="mt-4 grid grid-cols-1 gap-2 rounded-xl bg-muted p-4 font-mono text-sm sm:grid-cols-2">
            {recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={savedRecoveryCodes}
              onChange={(e) => setSavedRecoveryCodes(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            I have saved these recovery codes somewhere safe.
          </label>
          <Button
            className="mt-4 h-11 w-full"
            disabled={!savedRecoveryCodes}
            onClick={() => {
              setRecoveryCodes(null);
              router.push("/admin");
            }}
          >
            Done — go to the admin panel
          </Button>
        </div>
      </div>
    );
  }

  // MFA is enabled: status + management.
  if (status.enabled) {
    return (
      <div className="w-full max-w-lg space-y-4">
        {notice && <p className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
        {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-green-600" />
            <h2 className="text-lg font-bold">Multi-factor authentication is on</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Enabled {status.enabledAt ? new Date(status.enabledAt).toLocaleDateString() : ""}. You have{" "}
            {status.unusedRecoveryCodes} unused recovery code{status.unusedRecoveryCodes === 1 ? "" : "s"}.
          </p>
          <Button className="mt-4 h-11" disabled={busy} onClick={() => void regenerateCodes()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Regenerate recovery codes"}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Regenerating invalidates all previous recovery codes immediately.
          </p>
        </div>
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-bold">Replace authenticator</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Moving to a new phone or authenticator app? Enter your current password and a code from your current
            authenticator (or a recovery code). Your current authenticator keeps working until the new one is
            verified, and your recovery codes stay valid until then.
          </p>
          {!replacementQr ? (
            <form onSubmit={startReplacement} className="mt-4 space-y-4" noValidate>
              <div>
                <Label htmlFor="mfa-replace-password">Current password</Label>
                <Input
                  id="mfa-replace-password"
                  type="password"
                  value={replacePassword}
                  onChange={(e) => setReplacePassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  className="mt-1.5 h-11"
                />
              </div>
              <div>
                <Label htmlFor="mfa-replace-code">Current authenticator code or recovery code</Label>
                <Input
                  id="mfa-replace-code"
                  type="text"
                  inputMode="numeric"
                  value={replaceCode}
                  onChange={(e) => setReplaceCode(e.target.value)}
                  placeholder="123456 or XXXX-XXXXX"
                  autoComplete="one-time-code"
                  required
                  className="mt-1.5 h-11"
                />
              </div>
              <Button type="submit" className="h-11 w-full" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start replacement — show new QR code"}
              </Button>
            </form>
          ) : (
            <div className="mt-4">
              <div className="flex justify-center rounded-xl bg-white p-4">
                <Image src={replacementQr} alt="Replacement MFA setup QR code" width={220} height={220} />
              </div>
              <p className="mt-4 text-sm text-muted-foreground">
                Or enter this key manually in your new authenticator app:
              </p>
              <code className="mt-1 block break-all rounded-lg bg-muted p-3 font-mono text-sm">
                {replacementKey}
              </code>
              <form onSubmit={activate} className="mt-4 space-y-4" noValidate>
                <div>
                  <Label htmlFor="mfa-replace-activate-code">6-digit code from your new authenticator app</Label>
                  <Input
                    id="mfa-replace-activate-code"
                    type="text"
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                    placeholder="123456"
                    autoComplete="one-time-code"
                    required
                    className="mt-1.5 h-11"
                  />
                </div>
                <Button type="submit" className="h-11 w-full" disabled={busy || code.length !== 6}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify and switch to new authenticator"}
                </Button>
              </form>
              <Button
                variant="ghost"
                className="mt-2 h-11 w-full"
                disabled={busy}
                onClick={() => {
                  setReplacementQr(null);
                  setReplacementKey(null);
                  setReplacePassword("");
                  setReplaceCode("");
                  setNotice("Replacement abandoned. Your current authenticator and recovery codes still work.");
                }}
              >
                Cancel replacement
              </Button>
            </div>
          )}
        </div>
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-bold">Disable MFA</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Disabling MFA removes the extra protection on this account. You will need your current password and a
            code from your authenticator app (or a recovery code).
          </p>
          <form onSubmit={disableMfa} className="mt-4 space-y-4" noValidate>
            <div>
              <Label htmlFor="mfa-disable-password">Current password</Label>
              <Input
                id="mfa-disable-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="mt-1.5 h-11"
              />
            </div>
            <div>
              <Label htmlFor="mfa-disable-code">Authenticator code or recovery code</Label>
              <Input
                id="mfa-disable-code"
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
            <Button type="submit" variant="destructive" className="h-11 w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Disable MFA"}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  // Not enabled yet: enrollment.
  return (
    <div className="w-full max-w-lg space-y-4">
      {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {!qrCodeDataUrl ? (
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            <h2 className="text-lg font-bold">Set up multi-factor authentication</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            MFA is required for administrator accounts. Scan the QR code with Google Authenticator, Microsoft
            Authenticator, or Authy, then enter the 6-digit code to activate it.
          </p>
          <Button className="mt-4 h-11 w-full" disabled={busy} onClick={() => void startEnrollment()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start setup — show QR code"}
          </Button>
        </div>
      ) : (
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-bold">Scan with your authenticator app</h2>
          <div className="mt-4 flex justify-center rounded-xl bg-white p-4">
            <Image src={qrCodeDataUrl} alt="MFA setup QR code" width={220} height={220} />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Or enter this key manually in your authenticator app:
          </p>
          <code className="mt-1 block break-all rounded-lg bg-muted p-3 font-mono text-sm">{manualKey}</code>
          <form onSubmit={activate} className="mt-4 space-y-4" noValidate>
            <div>
              <Label htmlFor="mfa-activate-code">6-digit code from your authenticator app</Label>
              <Input
                id="mfa-activate-code"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="123456"
                autoComplete="one-time-code"
                required
                className="mt-1.5 h-11"
              />
            </div>
            <Button type="submit" className="h-11 w-full" disabled={busy || code.length !== 6}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify and activate MFA"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
