"use client";

// Addresses manager — CRUD with default handling (FR-05).
import { useState, useTransition } from "react";
import { Loader2, MapPin, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface AddressRow {
  id: string;
  label: string;
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  province: string;
  postalCode: string | null;
  isDefault: boolean;
}

const PROVINCES = [
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "Gilgit-Baltistan",
  "Azad Kashmir",
  "Islamabad Capital Territory",
];

interface Draft {
  id: string | null; // null = create
  label: string;
  fullName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  province: string;
  postalCode: string;
  isDefault: boolean;
}

function newDraft(isFirst: boolean): Draft {
  return {
    id: null,
    label: "Home",
    fullName: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    province: "Punjab",
    postalCode: "",
    isDefault: isFirst,
  };
}

export function AddressesManager({ initial }: { initial: AddressRow[] }) {
  const [addresses, setAddresses] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AddressRow | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  function openCreate() {
    setErrors({});
    setDraft(newDraft(addresses.length === 0));
  }
  function openEdit(a: AddressRow) {
    setErrors({});
    setDraft({
      id: a.id,
      label: a.label,
      fullName: a.fullName,
      phone: a.phone,
      line1: a.line1,
      line2: a.line2 ?? "",
      city: a.city,
      province: a.province,
      postalCode: a.postalCode ?? "",
      isDefault: a.isDefault,
    });
  }
  function close() {
    setDraft(null);
    setErrors({});
  }
  function set(field: keyof Draft, value: string | boolean) {
    setDraft((d) => (d ? { ...d, [field]: value } : d));
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          draft.id ? `/api/account/addresses/${draft.id}` : "/api/account/addresses",
          {
            method: draft.id ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...draft, id: undefined }),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setErrors(data.errors ?? { _: data.error ?? "Could not save address" });
          return;
        }
        const saved = data.address as AddressRow;
        setAddresses((prev) => {
          const next = draft.id ? prev.map((a) => (a.id === draft.id ? saved : a)) : [saved, ...prev];
          if (saved.isDefault) return next.map((a) => ({ ...a, isDefault: a.id === saved.id }));
          return next;
        });
        toast.success(draft.id ? "Address updated" : "Address added");
        close();
      } catch {
        setErrors({ _: "Network error — please try again." });
      }
    });
  }

  function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/account/addresses/${target.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not delete");
        const next = addresses.filter((a) => a.id !== target.id);
        if (target.isDefault && next.length > 0 && !next.some((a) => a.isDefault)) {
          const promote = next[0];
          await fetch(`/api/account/addresses/${promote.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...promote, isDefault: true }),
          });
          setAddresses(next.map((a) => ({ ...a, isDefault: a.id === promote.id })));
        } else {
          setAddresses(next);
        }
        toast.success("Address deleted");
      } catch {
        toast.error("Could not delete this address. Please try again.");
      } finally {
        setDeleting(null);
      }
    });
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Delivery Addresses</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage where your orders are delivered</p>
        </div>
        <Button className="gap-1.5" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Address
        </Button>
      </div>

      {addresses.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <MapPin className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">No saved addresses yet</p>
          <Button className="mt-4" onClick={openCreate}>
            Add your first address
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {addresses.map((a) => (
            <div
              key={a.id}
              className={cn("relative rounded-xl border p-4", a.isDefault && "border-primary/40 bg-brand-50/50")}
            >
              {a.isDefault && (
                <span className="absolute -top-2.5 left-4 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                  <Star className="h-2.5 w-2.5 fill-current" /> Default
                </span>
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold">
                    {a.label} — {a.fullName}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {a.line1}
                    {a.line2 ? `, ${a.line2}` : ""}
                    <br />
                    {a.city}, {a.province} {a.postalCode ?? ""}
                    <br />
                    {a.phone}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(a)}
                    className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    aria-label={`Edit ${a.label} address`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleting(a)}
                    className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Delete ${a.label} address`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={draft !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit Address" : "Add New Address"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" noValidate>
              <div>
                <Label className="text-xs text-muted-foreground">Label</Label>
                <Input value={draft.label} onChange={(e) => set("label", e.target.value)} placeholder="Home / Office" className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Recipient name</Label>
                <Input value={draft.fullName} onChange={(e) => set("fullName", e.target.value)} className="mt-1.5" aria-invalid={Boolean(errors.fullName)} />
                {errors.fullName && <p className="mt-1 text-xs text-destructive" role="alert">{errors.fullName}</p>}
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Phone</Label>
                <Input value={draft.phone} onChange={(e) => set("phone", e.target.value)} placeholder="0300 1234567" inputMode="tel" className="mt-1.5" aria-invalid={Boolean(errors.phone)} />
                {errors.phone && <p className="mt-1 text-xs text-destructive" role="alert">{errors.phone}</p>}
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">City</Label>
                <Input value={draft.city} onChange={(e) => set("city", e.target.value)} className="mt-1.5" aria-invalid={Boolean(errors.city)} />
                {errors.city && <p className="mt-1 text-xs text-destructive" role="alert">{errors.city}</p>}
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs text-muted-foreground">Street address</Label>
                <Input value={draft.line1} onChange={(e) => set("line1", e.target.value)} placeholder="House no, street, area" className="mt-1.5" aria-invalid={Boolean(errors.line1)} />
                {errors.line1 && <p className="mt-1 text-xs text-destructive" role="alert">{errors.line1}</p>}
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs text-muted-foreground">Apartment, floor (optional)</Label>
                <Input value={draft.line2} onChange={(e) => set("line2", e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Province</Label>
                <select
                  value={draft.province}
                  onChange={(e) => set("province", e.target.value)}
                  className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Province"
                >
                  {PROVINCES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Postal code (optional)</Label>
                <Input value={draft.postalCode} onChange={(e) => set("postalCode", e.target.value)} className="mt-1.5" inputMode="numeric" />
              </div>
              <label className="flex cursor-pointer items-center gap-2 sm:col-span-2">
                <Checkbox checked={draft.isDefault} onCheckedChange={(c) => set("isDefault", c === true)} />
                <span className="text-sm">Set as default address</span>
              </label>
              {errors._ && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-2" role="alert">
                  {errors._}
                </p>
              )}
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" onClick={close}>
                  <X className="mr-1 h-4 w-4" /> Cancel
                </Button>
                <Button type="submit" disabled={saving} className="gap-2">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {draft.id ? "Save Changes" : "Add Address"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this address?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the &quot;{deleting?.label}&quot; address from your
              account. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete Address
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
