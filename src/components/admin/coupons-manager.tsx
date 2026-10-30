"use client";

// Admin coupons manager — confirmed rules (D-06): PERCENT/FIXED, min order,
// validity window, usage limit (FR-42).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Tags, Trash2 } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPKR } from "@/lib/utils";

export interface AdminCoupon {
  id: string;
  code: string;
  description: string | null;
  type: "PERCENT" | "FIXED";
  value: number;
  minOrderAmount: number;
  maxUses: number | null;
  usedCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
}

interface Draft {
  id: string | null;
  code: string;
  description: string;
  type: "PERCENT" | "FIXED";
  value: number | string;
  minOrderAmount: number | string;
  maxUses: number | string;
  startsAt: string;
  expiresAt: string;
  isActive: boolean;
}

function toInputDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

export function CouponsManager({ initial }: { initial: AdminCoupon[] }) {
  const router = useRouter();
  const [coupons, setCoupons] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AdminCoupon | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  function openCreate() {
    setErrors({});
    setDraft({ id: null, code: "", description: "", type: "PERCENT", value: "", minOrderAmount: 0, maxUses: "", startsAt: "", expiresAt: "", isActive: true });
  }
  function openEdit(c: AdminCoupon) {
    setErrors({});
    setDraft({
      id: c.id,
      code: c.code,
      description: c.description ?? "",
      type: c.type,
      value: c.value,
      minOrderAmount: c.minOrderAmount,
      maxUses: c.maxUses ?? "",
      startsAt: toInputDate(c.startsAt),
      expiresAt: toInputDate(c.expiresAt),
      isActive: c.isActive,
    });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    startTransition(async () => {
      try {
        const res = await fetch(draft.id ? `/api/admin/coupons/${draft.id}` : "/api/admin/coupons", {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: draft.code,
            description: draft.description,
            type: draft.type,
            value: Number(draft.value) || 0,
            minOrderAmount: Number(draft.minOrderAmount) || 0,
            maxUses: draft.maxUses ? Number(draft.maxUses) : null,
            startsAt: draft.startsAt || "",
            expiresAt: draft.expiresAt || "",
            isActive: draft.isActive,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setErrors(data.errors ?? { _: data.error ?? "Could not save coupon" });
          return;
        }
        toast.success(draft.id ? "Coupon updated" : "Coupon created");
        setDraft(null);
        router.refresh();
      } catch {
        setErrors({ _: "Network error — please try again." });
      }
    });
  }

  function confirmDelete() {
    if (!deleting) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/coupons/${deleting.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Delete failed");
        toast.success("Coupon deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not delete coupon");
      } finally {
        setDeleting(null);
      }
    });
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Coupons</h1>
          <p className="mt-1 text-sm text-muted-foreground">Discount codes customers apply at checkout</p>
        </div>
        <Button className="gap-1.5" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Coupon
        </Button>
      </div>

      {coupons.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <Tags className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">No coupons yet</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Code</th>
                <th className="px-4 py-3 font-semibold">Discount</th>
                <th className="px-4 py-3 font-semibold">Min Order</th>
                <th className="px-4 py-3 font-semibold">Usage</th>
                <th className="px-4 py-3 font-semibold">Valid Until</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {coupons.map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <p className="font-mono font-bold">{c.code}</p>
                    {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                  </td>
                  <td className="px-4 py-3 font-semibold text-primary">
                    {c.type === "PERCENT" ? `${c.value}%` : formatPKR(c.value)}
                  </td>
                  <td className="px-4 py-3">{c.minOrderAmount > 0 ? formatPKR(c.minOrderAmount) : "—"}</td>
                  <td className="px-4 py-3">
                    {c.usedCount}
                    {c.maxUses ? ` / ${c.maxUses}` : ""}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "No expiry"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${c.isActive ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                      {c.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button type="button" onClick={() => openEdit(c)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${c.code}`}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => setDeleting(c)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${c.code}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit Coupon" : "Add Coupon"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" noValidate>
              <div>
                <Label>Code *</Label>
                <Input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
                  placeholder="WELCOME10"
                  className="mt-1.5 font-mono"
                  aria-invalid={Boolean(errors.code)}
                />
                {errors.code && <p className="mt-1 text-xs text-destructive" role="alert">{errors.code}</p>}
              </div>
              <div>
                <Label>Type *</Label>
                <select
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as Draft["type"] })}
                  className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  aria-label="Discount type"
                >
                  <option value="PERCENT">Percentage (%)</option>
                  <option value="FIXED">Fixed amount (PKR)</option>
                </select>
              </div>
              <div>
                <Label>{draft.type === "PERCENT" ? "Percent off (1-100) *" : "Amount off (PKR) *"}</Label>
                <Input type="number" min={1} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} className="mt-1.5" aria-invalid={Boolean(errors.value)} />
                {errors.value && <p className="mt-1 text-xs text-destructive" role="alert">{errors.value}</p>}
              </div>
              <div>
                <Label>Minimum order (PKR)</Label>
                <Input type="number" min={0} value={draft.minOrderAmount} onChange={(e) => setDraft({ ...draft, minOrderAmount: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label>Usage limit (optional)</Label>
                <Input type="number" min={1} value={draft.maxUses} onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })} placeholder="Unlimited" className="mt-1.5" />
              </div>
              <div>
                <Label>Start date</Label>
                <Input type="date" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label>Expiry date</Label>
                <Input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Label>Description</Label>
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-1.5" />
              </div>
              <label className="flex cursor-pointer items-center gap-2 sm:col-span-2">
                <Checkbox checked={draft.isActive} onCheckedChange={(c) => setDraft({ ...draft, isActive: c === true })} />
                <span className="text-sm">Active — usable at checkout</span>
              </label>
              {errors._ && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-2" role="alert">{errors._}</p>}
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <Button type="submit" disabled={saving} className="gap-2">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {draft.id ? "Save Changes" : "Create Coupon"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete coupon &quot;{deleting?.code}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>Customers will no longer be able to use this code.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
