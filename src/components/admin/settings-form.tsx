"use client";

// Admin store settings (FR-44, FR-32, FR-51) — all routine config without code edits.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

export interface SettingsValues {
  store_name: string;
  store_tagline: string;
  store_email: string;
  store_phone: string;
  store_address: string;
  whatsapp_number: string;
  announcement_text: string;
  cod_enabled: boolean;
  bank_transfer_enabled: boolean;
  online_payment_enabled: boolean;
  delivery_fee_standard: number | string;
  delivery_fee_express: number | string;
  free_delivery_threshold: number | string;
  gift_wrap_enabled: boolean;
  gift_wrap_charge: number | string;
  gift_wrap_description: string;
  facebook_url: string;
  instagram_url: string;
}

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...values,
            delivery_fee_standard: Number(values.delivery_fee_standard) || 0,
            delivery_fee_express: Number(values.delivery_fee_express) || 0,
            free_delivery_threshold: Number(values.free_delivery_threshold) || 0,
            gift_wrap_charge: Number(values.gift_wrap_charge) || 0,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setErrors(data.errors ?? { _: data.error ?? "Could not save settings" });
          toast.error("Please correct the highlighted fields.");
          return;
        }
        toast.success("Settings saved — storefront updated instantly");
        router.refresh();
      } catch {
        setErrors({ _: "Network error — please try again." });
      }
    });
  }

  return (
    <form onSubmit={save} className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Store Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Store name" error={errors.store_name}>
            <Input value={values.store_name} onChange={(e) => set("store_name", e.target.value)} />
          </Field>
          <Field label="Tagline" error={errors.store_tagline}>
            <Input value={values.store_tagline} onChange={(e) => set("store_tagline", e.target.value)} />
          </Field>
          <Field label="Announcement bar text" error={errors.announcement_text}>
            <Input value={values.announcement_text} onChange={(e) => set("announcement_text", e.target.value)} placeholder="Free Delivery on Orders Above Rs 3,000" />
          </Field>
          <Field label="Store email" error={errors.store_email}>
            <Input type="email" value={values.store_email} onChange={(e) => set("store_email", e.target.value)} />
          </Field>
          <Field label="Store phone" error={errors.store_phone}>
            <Input value={values.store_phone} onChange={(e) => set("store_phone", e.target.value)} />
          </Field>
          <Field label="Store address" error={errors.store_address}>
            <Textarea rows={2} value={values.store_address} onChange={(e) => set("store_address", e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">WhatsApp (FR-33..37)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="WhatsApp number (digits with country code)" error={errors.whatsapp_number}>
              <Input value={values.whatsapp_number} onChange={(e) => set("whatsapp_number", e.target.value)} placeholder="923001234567" />
            </Field>
            <p className="text-xs text-muted-foreground">
              Used across the storefront: header, floating button, product pages and assisted-order
              messages. Inquiries are always distinct from confirmed website orders.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment Methods</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Toggle
              checked={values.cod_enabled}
              onChange={(c) => set("cod_enabled", c)}
              label="Cash on Delivery"
              desc="Pay when the order is delivered"
            />
            <Toggle
              checked={values.bank_transfer_enabled}
              onChange={(c) => set("bank_transfer_enabled", c)}
              label="Bank Transfer"
              desc="Manual transfer — details shared with customer"
            />
            <Toggle
              checked={values.online_payment_enabled}
              onChange={(c) => set("online_payment_enabled", c)}
              label="Online Payments (gateway)"
              desc="Requires a payment provider + credentials — see docs/SUPABASE-SETUP.md"
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery Charges</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Standard fee (PKR)" error={errors.delivery_fee_standard}>
            <Input type="number" min={0} value={values.delivery_fee_standard} onChange={(e) => set("delivery_fee_standard", e.target.value)} />
          </Field>
          <Field label="Express fee (PKR)" error={errors.delivery_fee_express}>
            <Input type="number" min={0} value={values.delivery_fee_express} onChange={(e) => set("delivery_fee_express", e.target.value)} />
          </Field>
          <Field label="Free delivery threshold (PKR)" error={errors.free_delivery_threshold}>
            <Input type="number" min={0} value={values.free_delivery_threshold} onChange={(e) => set("free_delivery_threshold", e.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            Standard delivery becomes free when the subtotal reaches the threshold. Existing orders
            keep their recorded delivery fee (BR-15).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gift Wrapping (FR-28..32)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            checked={values.gift_wrap_enabled}
            onChange={(c) => set("gift_wrap_enabled", c)}
            label="Enable gift wrapping"
            desc="Customers can opt in during checkout"
          />
          <Field label="Charge per order (PKR)" error={errors.gift_wrap_charge}>
            <Input type="number" min={0} value={values.gift_wrap_charge} onChange={(e) => set("gift_wrap_charge", e.target.value)} />
          </Field>
          <Field label="Description shown at checkout" error={errors.gift_wrap_description}>
            <Input value={values.gift_wrap_description} onChange={(e) => set("gift_wrap_description", e.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground">
            One flat charge per order. Updating the charge never changes totals of existing orders (BR-15).
          </p>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Social Links</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Facebook URL" error={errors.facebook_url}>
            <Input value={values.facebook_url} onChange={(e) => set("facebook_url", e.target.value)} placeholder="https://facebook.com/..." />
          </Field>
          <Field label="Instagram URL" error={errors.instagram_url}>
            <Input value={values.instagram_url} onChange={(e) => set("instagram_url", e.target.value)} placeholder="https://instagram.com/..." />
          </Field>
        </CardContent>
      </Card>

      {errors._ && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive lg:col-span-2" role="alert">
          {errors._}
        </p>
      )}

      <div className="sticky bottom-4 flex justify-end lg:col-span-2">
        <Button type="submit" size="lg" disabled={saving} className="gap-2 shadow-lg">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Settings
        </Button>
      </div>
    </form>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="mt-1.5">{children}</div>
      {error && <p className="mt-1 text-xs font-medium text-destructive" role="alert">{error}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  desc,
}: {
  checked: boolean;
  onChange: (c: boolean) => void;
  label: string;
  desc: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition hover:bg-muted/50">
      <Checkbox checked={checked} onCheckedChange={(c) => onChange(c === true)} className="mt-0.5" />
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{desc}</span>
      </span>
    </label>
  );
}
