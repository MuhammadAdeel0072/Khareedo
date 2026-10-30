"use client";

// Admin promotions manager (FR-42) — store-managed discount campaigns.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
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

export interface AdminPromotion {
  id: string;
  title: string;
  description: string | null;
  type: "PERCENT" | "FIXED";
  value: number;
  minOrderAmount: number | null;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
}

interface Draft {
  id: string | null;
  title: string;
  description: string;
  type: "PERCENT" | "FIXED";
  value: number | string;
  minOrderAmount: number | string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

function toInputDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

export function PromotionsManager({ initial }: { initial: AdminPromotion[] }) {
  const router = useRouter();
  const [promotions, setPromotions] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AdminPromotion | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  function openCreate() {
    setErrors({});
    setDraft({ id: null, title: "", description: "", type: "PERCENT", value: "", minOrderAmount: "", startsAt: "", endsAt: "", isActive: true });
  }
  function openEdit(p: AdminPromotion) {
    setErrors({});
    setDraft({
      id: p.id,
      title: p.title,
      description: p.description ?? "",
      type: p.type,
      value: p.value,
      minOrderAmount: p.minOrderAmount ?? "",
      startsAt: toInputDate(p.startsAt),
      endsAt: toInputDate(p.endsAt),
      isActive: p.isActive,
    });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    startTransition(async () => {
      try {
        const res = await fetch(draft.id ? `/api/admin/promotions/${draft.id}` : "/api/admin/promotions", {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: draft.title,
            description: draft.description,
            type: draft.type,
            value: Number(draft.value) || 0,
            minOrderAmount: draft.minOrderAmount ? Number(draft.minOrderAmount) : null,
            startsAt: draft.startsAt || "",
            endsAt: draft.endsAt || "",
            isActive: draft.isActive,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setErrors(data.errors ?? { _: data.error ?? "Could not save promotion" });
          return;
        }
        toast.success(draft.id ? "Promotion updated" : "Promotion created");
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
        const res = await fetch(`/api/admin/promotions/${deleting.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Delete failed");
        toast.success("Promotion deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not delete promotion");
      } finally {
        setDeleting(null);
      }
    });
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Promotions</h1>
          <p className="mt-1 text-sm text-muted-foreground">Store-managed discount campaigns shown on the storefront</p>
        </div>
        <Button className="gap-1.5" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Promotion
        </Button>
      </div>

      {promotions.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <Megaphone className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">No promotions yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {promotions.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-primary">
                <Megaphone className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">
                  {p.title} — <span className="text-primary">{p.type === "PERCENT" ? `${p.value}% OFF` : `${formatPKR(p.value)} OFF`}</span>
                </p>
                {p.description && <p className="truncate text-xs text-muted-foreground">{p.description}</p>}
              </div>
              <div className="text-xs text-muted-foreground">
                {p.startsAt ? `from ${new Date(p.startsAt).toLocaleDateString("en-GB")}` : ""}
                {p.endsAt ? ` until ${new Date(p.endsAt).toLocaleDateString("en-GB")}` : ""}
                {!p.startsAt && !p.endsAt && "always"}
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${p.isActive ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                {p.isActive ? "Active" : "Inactive"}
              </span>
              <div className="flex gap-1">
                <button type="button" onClick={() => openEdit(p)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${p.title}`}>
                  <Pencil className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setDeleting(p)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${p.title}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit Promotion" : "Add Promotion"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" noValidate>
              <div className="sm:col-span-2">
                <Label>Title *</Label>
                <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="mt-1.5" aria-invalid={Boolean(errors.title)} />
                {errors.title && <p className="mt-1 text-xs text-destructive" role="alert">{errors.title}</p>}
              </div>
              <div>
                <Label>Type *</Label>
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Draft["type"] })} className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" aria-label="Promotion type">
                  <option value="PERCENT">Percentage (%)</option>
                  <option value="FIXED">Fixed amount (PKR)</option>
                </select>
              </div>
              <div>
                <Label>{draft.type === "PERCENT" ? "Percent (1-100) *" : "Amount (PKR) *"}</Label>
                <Input type="number" min={1} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} className="mt-1.5" aria-invalid={Boolean(errors.value)} />
                {errors.value && <p className="mt-1 text-xs text-destructive" role="alert">{errors.value}</p>}
              </div>
              <div>
                <Label>Minimum order (PKR, optional)</Label>
                <Input type="number" min={0} value={draft.minOrderAmount} onChange={(e) => setDraft({ ...draft, minOrderAmount: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label>Start date</Label>
                <Input type="date" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label>End date</Label>
                <Input type="date" value={draft.endsAt} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Label>Description</Label>
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-1.5" />
              </div>
              <label className="flex cursor-pointer items-center gap-2 sm:col-span-2">
                <Checkbox checked={draft.isActive} onCheckedChange={(c) => setDraft({ ...draft, isActive: c === true })} />
                <span className="text-sm">Active — shown on storefront</span>
              </label>
              {errors._ && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-2" role="alert">{errors._}</p>}
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <Button type="submit" disabled={saving} className="gap-2">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {draft.id ? "Save Changes" : "Create Promotion"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleting?.title}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>This promotion will be removed from the storefront.</AlertDialogDescription>
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
