"use client";

// Profile form (FR-05).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ProfileForm({
  initial,
}: {
  initial: { name: string; email: string; phone: string };
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setSaving(true);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrors(data.errors ?? { _: data.error ?? "Could not save profile" });
        return;
      }
      toast.success("Profile updated successfully");
      router.refresh();
    } catch {
      setErrors({ _: "Network error — please try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="p-name">Full name</Label>
        <Input
          id="p-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1.5 h-11"
          aria-invalid={Boolean(errors.name)}
        />
        {errors.name && <p className="mt-1 text-xs font-medium text-destructive" role="alert">{errors.name}</p>}
      </div>
      <div>
        <Label htmlFor="p-email">Email address</Label>
        <Input id="p-email" value={initial.email} disabled className="mt-1.5 h-11 bg-muted" aria-describedby="p-email-hint" />
        <p id="p-email-hint" className="mt-1 text-xs text-muted-foreground">
          Email cannot be changed
        </p>
      </div>
      <div>
        <Label htmlFor="p-phone">Phone</Label>
        <Input
          id="p-phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0300 1234567"
          inputMode="tel"
          className="mt-1.5 h-11"
          aria-invalid={Boolean(errors.phone)}
        />
        {errors.phone && <p className="mt-1 text-xs font-medium text-destructive" role="alert">{errors.phone}</p>}
      </div>
      {errors._ && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive" role="alert">
          {errors._}
        </p>
      )}
      <Button type="submit" disabled={saving} className="gap-2">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save Changes
      </Button>
    </form>
  );
}
