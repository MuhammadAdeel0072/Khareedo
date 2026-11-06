"use client";

// Admin categories manager (FR-40) — tree list + create/edit dialog.
import Image from "next/image";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Boxes, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
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
import { slugify } from "@/lib/utils";

export interface AdminCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  parentId: string | null;
  parentName: string | null;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
}

interface Draft {
  id: string | null;
  name: string;
  slug: string;
  description: string;
  imageUrl: string;
  parentId: string;
  isActive: boolean;
  sortOrder: number | string;
}

export function CategoriesManager({ initial }: { initial: AdminCategory[] }) {
  const router = useRouter();
  const categories = initial;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AdminCategory | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  const roots = categories.filter((c) => !c.parentId);

  function openCreate(parentId = "") {
    setErrors({});
    setDraft({
      id: null,
      name: "",
      slug: "",
      description: "",
      imageUrl: "",
      parentId,
      isActive: true,
      sortOrder: (categories.filter((c) => c.parentId === parentId).length ?? 0) + 1,
    });
  }

  function openEdit(c: AdminCategory) {
    setErrors({});
    setDraft({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description ?? "",
      imageUrl: c.imageUrl ?? "",
      parentId: c.parentId ?? "",
      isActive: c.isActive,
      sortOrder: c.sortOrder,
    });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    startTransition(async () => {
      try {
        const res = await fetch(
          draft.id ? `/api/admin/categories/${draft.id}` : "/api/admin/categories",
          {
            method: draft.id ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: draft.name,
              slug: draft.slug || undefined,
              description: draft.description,
              imageUrl: draft.imageUrl,
              parentId: draft.parentId || null,
              isActive: draft.isActive,
              sortOrder: Number(draft.sortOrder) || 0,
            }),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setErrors(data.errors ?? { _: data.error ?? "Could not save category" });
          return;
        }
        toast.success(draft.id ? "Category updated" : "Category created");
        setDraft(null);
        router.refresh();
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
        const res = await fetch(`/api/admin/categories/${target.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not delete");
        toast.success("Category deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not delete category");
      } finally {
        setDeleting(null);
      }
    });
  }

  function renderRow(c: AdminCategory, depth = 0) {
    return (
      <div key={c.id}>
        <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
          <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-muted" style={{ marginLeft: depth * 20 }}>
            <Image src={c.imageUrl ?? "/images/placeholder.svg"} alt="" fill sizes="40px" className="object-cover" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {depth > 0 && <span className="mr-1 text-muted-foreground">↳</span>}
              {c.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              /{c.slug} · {c.productCount} product{c.productCount === 1 ? "" : "s"}
              {c.parentName ? ` · under ${c.parentName}` : ""}
            </p>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              c.isActive ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"
            }`}
          >
            {c.isActive ? "Active" : "Hidden"}
          </span>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => openEdit(c)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Edit ${c.name}`}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDeleting(c)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Delete ${c.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
        {categories.filter((ch) => ch.parentId === c.id).map((ch) => renderRow(ch, depth + 1))}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Categories</h1>
          <p className="mt-1 text-sm text-muted-foreground">Organise your catalogue structure</p>
        </div>
        <Button className="gap-1.5" onClick={() => openCreate()}>
          <Plus className="h-4 w-4" /> Add Category
        </Button>
      </div>

      {categories.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center">
          <Boxes className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">No categories yet</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">{roots.map((c) => renderRow(c))}</div>
      )}

      {/* Dialog */}
      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit Category" : "Add Category"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <form onSubmit={save} className="space-y-3" noValidate>
              <div>
                <Label>Name *</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-1.5" aria-invalid={Boolean(errors.name)} />
                {errors.name && <p className="mt-1 text-xs text-destructive" role="alert">{errors.name}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>URL slug</Label>
                  <Input
                    value={draft.slug}
                    onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                    placeholder={draft.name ? slugify(draft.name) : "auto"}
                    className="mt-1.5 font-mono text-sm"
                  />
                </div>
                <div>
                  <Label>Sort order</Label>
                  <Input type="number" min={0} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label>Parent category</Label>
                <select
                  value={draft.parentId}
                  onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}
                  className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  aria-label="Parent category"
                >
                  <option value="">None (top level)</option>
                  {roots
                    .filter((r) => r.id !== draft.id)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <Label>Description</Label>
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-1.5" />
              </div>
              <div>
                <Label>Image URL (optional)</Label>
                <Input value={draft.imageUrl} onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })} className="mt-1.5" placeholder="/uploads/category.png" />
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={draft.isActive} onCheckedChange={(c) => setDraft({ ...draft, isActive: c === true })} />
                <span className="text-sm">Active — visible in storefront navigation</span>
              </label>
              {errors._ && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{errors._}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving} className="gap-2">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {draft.id ? "Save Changes" : "Create Category"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleting?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              Categories with products or subcategories cannot be deleted. Move them first.
            </AlertDialogDescription>
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
