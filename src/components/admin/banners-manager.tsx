"use client";

// Admin banners manager (FR-42, FR-51) — hero/side/strip promotional content.
import Image from "next/image";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";

export interface AdminBanner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  linkUrl: string | null;
  placement: "HERO" | "SIDE" | "STRIP";
  isActive: boolean;
  sortOrder: number;
}

interface Draft {
  id: string | null;
  title: string;
  subtitle: string;
  imageUrl: string;
  linkUrl: string;
  placement: "HERO" | "SIDE" | "STRIP";
  isActive: boolean;
  sortOrder: number | string;
}

const PLACEMENT_LABEL: Record<string, string> = {
  HERO: "Hero carousel",
  SIDE: "Side promo",
  STRIP: "Strip",
};

export function BannersManager({ initial }: { initial: AdminBanner[] }) {
  const router = useRouter();
  const banners = initial;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AdminBanner | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  function openCreate() {
    setErrors({});
    setDraft({ id: null, title: "", subtitle: "", imageUrl: "", linkUrl: "/products", placement: "HERO", isActive: true, sortOrder: banners.length + 1 });
  }
  function openEdit(b: AdminBanner) {
    setErrors({});
    setDraft({ id: b.id, title: b.title, subtitle: b.subtitle ?? "", imageUrl: b.imageUrl, linkUrl: b.linkUrl ?? "", placement: b.placement, isActive: b.isActive, sortOrder: b.sortOrder });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    startTransition(async () => {
      try {
        const res = await fetch(draft.id ? `/api/admin/banners/${draft.id}` : "/api/admin/banners", {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, sortOrder: Number(draft.sortOrder) || 0, id: undefined }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setErrors(data.errors ?? { _: data.error ?? "Could not save banner" });
          return;
        }
        toast.success(draft.id ? "Banner updated" : "Banner created");
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
        const res = await fetch(`/api/admin/banners/${deleting.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Delete failed");
        toast.success("Banner deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not delete banner");
      } finally {
        setDeleting(null);
      }
    });
  }

  const groups: Array<["HERO" | "SIDE" | "STRIP", string]> = [
    ["HERO", "Hero carousel (homepage slider)"],
    ["SIDE", "Side promos (homepage right cards)"],
    ["STRIP", "Strips"],
  ];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Banners</h1>
          <p className="mt-1 text-sm text-muted-foreground">Homepage promotional content — changes go live instantly</p>
        </div>
        <Button className="gap-1.5" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Banner
        </Button>
      </div>

      {groups.map(([placement, label]) => {
        const rows = banners.filter((b) => b.placement === placement);
        return (
          <section key={placement} className="mb-6">
            <h2 className="mb-2 text-sm font-bold text-muted-foreground">{label}</h2>
            {rows.length === 0 ? (
              <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No banners here yet.</p>
            ) : (
              <div className="grid gap-3 [&>*]:min-w-0 lg:grid-cols-2">
                {rows.map((b) => (
                  <div key={b.id} className={cn("flex gap-4 rounded-xl border bg-card p-4", !b.isActive && "opacity-60")}>
                    <span className="relative h-20 w-36 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <Image src={b.imageUrl} alt="" fill sizes="150px" className="object-cover" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{b.title}</p>
                      {b.subtitle && <p className="truncate text-xs text-muted-foreground">{b.subtitle}</p>}
                      <p className="mt-1 truncate text-xs text-muted-foreground">→ {b.linkUrl ?? "no link"}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", b.isActive ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground")}>
                          {b.isActive ? "Active" : "Hidden"}
                        </span>
                        <span className="text-[10px] text-muted-foreground">sort {b.sortOrder}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button type="button" onClick={() => openEdit(b)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${b.title}`}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={() => setDeleting(b)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Delete ${b.title}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit Banner" : "Add Banner"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <form onSubmit={save} className="space-y-3" noValidate>
              <div>
                <Label>Title *</Label>
                <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="mt-1.5" aria-invalid={Boolean(errors.title)} />
                {errors.title && <p className="mt-1 text-xs text-destructive" role="alert">{errors.title}</p>}
              </div>
              <div>
                <Label>Subtitle</Label>
                <Input value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label>Image URL *</Label>
                <Input value={draft.imageUrl} onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })} className="mt-1.5" placeholder="/uploads/banner.png" aria-invalid={Boolean(errors.imageUrl)} />
                {errors.imageUrl && <p className="mt-1 text-xs text-destructive" role="alert">{errors.imageUrl}</p>}
                {draft.imageUrl && (
                  <span className="relative mt-2 block aspect-[2.4/1] overflow-hidden rounded-lg border bg-muted">
                    <Image src={draft.imageUrl} alt="Banner preview" fill sizes="500px" className="object-cover" />
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Placement</Label>
                  <select
                    value={draft.placement}
                    onChange={(e) => setDraft({ ...draft, placement: e.target.value as Draft["placement"] })}
                    className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    aria-label="Banner placement"
                  >
                    {(["HERO", "SIDE", "STRIP"] as const).map((p) => (
                      <option key={p} value={p}>{PLACEMENT_LABEL[p]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Sort order</Label>
                  <Input type="number" min={0} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label>Link URL</Label>
                <Input value={draft.linkUrl} onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} className="mt-1.5" placeholder="/products?category=..." />
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={draft.isActive} onCheckedChange={(c) => setDraft({ ...draft, isActive: c === true })} />
                <span className="text-sm">Active — visible on storefront</span>
              </label>
              {errors._ && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{errors._}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                <Button type="submit" disabled={saving} className="gap-2">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {draft.id ? "Save Changes" : "Create Banner"}
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
            <AlertDialogDescription>This banner will be removed from the storefront immediately.</AlertDialogDescription>
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
