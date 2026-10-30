"use client";

// Product create/edit dialog (FR-39/40) — opens inline like Add Category.
// SKU is system-assigned server-side; no manual entry field.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { slugify } from "@/lib/utils";

export interface ProductDialogValues {
  id?: string;
  name: string;
  slug: string;
  description: string;
  brand: string;
  categoryId: string;
  price: number | string;
  comparePrice: number | string | null;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  isFeatured: boolean;
  rating: number | string;
  reviewCount: number | string;
  tags: string;
  images: string[];
  stock: number | string;
  lowStockThreshold: number | string;
}

export const EMPTY_PRODUCT: ProductDialogValues = {
  name: "",
  slug: "",
  description: "",
  brand: "",
  categoryId: "",
  price: "",
  comparePrice: null,
  status: "PUBLISHED",
  isFeatured: false,
  rating: 0,
  reviewCount: 0,
  tags: "",
  images: [],
  stock: 0,
  lowStockThreshold: 5,
};

export function ProductDialog({
  open,
  initial,
  categories,
  sku,
  onClose,
}: {
  open: boolean;
  initial: ProductDialogValues;
  categories: Array<{ id: string; name: string }>;
  sku?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const isEdit = Boolean(initial.id);
  const [values, setValues] = useState<ProductDialogValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-seed the draft each time the dialog opens.
  useEffect(() => {
    if (open) {
      setValues(initial);
      setErrors({});
    }
  }, [open, initial]);

  function set<K extends keyof ProductDialogValues>(key: K, value: ProductDialogValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function onNameBlur() {
    if (!isEdit && !values.slug && values.name) set("slug", slugify(values.name));
  }

  async function uploadImage(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Upload failed");
      set("images", [...values.images, data.url].slice(0, 8));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Image upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setSaving(true);
    try {
      const res = await fetch(isEdit ? `/api/admin/products/${initial.id}` : "/api/admin/products", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          slug: values.slug || undefined,
          description: values.description,
          brand: values.brand || "",
          categoryId: values.categoryId,
          price: Number(values.price),
          comparePrice: values.comparePrice ? Number(values.comparePrice) : null,
          status: values.status,
          isFeatured: values.isFeatured,
          rating: Number(values.rating) || 0,
          reviewCount: Number(values.reviewCount) || 0,
          stock: Number(values.stock) || 0,
          lowStockThreshold: Number(values.lowStockThreshold) || 5,
          tags: values.tags || "",
          images: values.images,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrors(data.errors ?? { _: data.error ?? "Could not save product" });
        toast.error(data.errors ? "Please correct the highlighted fields." : data.error ?? "Save failed");
        return;
      }
      toast.success(isEdit ? "Product updated" : "Product created");
      onClose();
      router.refresh();
    } catch {
      setErrors({ _: "Network error — please try again." });
    } finally {
      setSaving(false);
    }
  }

  const selectCls =
    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Product" : "Add Product"}</DialogTitle>
          {isEdit && sku && (
            <p className="text-xs text-muted-foreground">
              SKU <span className="font-mono font-medium text-foreground">{sku}</span> · auto-assigned
            </p>
          )}
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="pd-name">Product name *</Label>
              <Input
                id="pd-name"
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                onBlur={onNameBlur}
                className="mt-1.5"
                aria-invalid={Boolean(errors.name)}
              />
              {errors.name && <p className="mt-1 text-xs text-destructive" role="alert">{errors.name}</p>}
            </div>

            <div>
              <Label htmlFor="pd-cat">Category *</Label>
              <select
                id="pd-cat"
                value={values.categoryId}
                onChange={(e) => set("categoryId", e.target.value)}
                className={`mt-1.5 ${selectCls}`}
                aria-invalid={Boolean(errors.categoryId)}
              >
                <option value="">Choose…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {errors.categoryId && <p className="mt-1 text-xs text-destructive" role="alert">{errors.categoryId}</p>}
            </div>

            <div>
              <Label htmlFor="pd-brand">Brand</Label>
              <Input id="pd-brand" value={values.brand} onChange={(e) => set("brand", e.target.value)} className="mt-1.5" placeholder="e.g. Casio" />
            </div>

            <div>
              <Label htmlFor="pd-price">Price (PKR) *</Label>
              <Input
                id="pd-price"
                type="number"
                min={1}
                value={values.price}
                onChange={(e) => set("price", e.target.value)}
                className="mt-1.5"
                aria-invalid={Boolean(errors.price)}
              />
              {errors.price && <p className="mt-1 text-xs text-destructive" role="alert">{errors.price}</p>}
            </div>

            <div>
              <Label htmlFor="pd-compare">Compare-at price</Label>
              <Input
                id="pd-compare"
                type="number"
                min={0}
                value={values.comparePrice ?? ""}
                onChange={(e) => set("comparePrice", e.target.value)}
                className="mt-1.5"
                placeholder="Shows as discount"
                aria-invalid={Boolean(errors.comparePrice)}
              />
              {errors.comparePrice && <p className="mt-1 text-xs text-destructive" role="alert">{errors.comparePrice}</p>}
            </div>

            <div>
              <Label htmlFor="pd-stock">Stock quantity</Label>
              <Input
                id="pd-stock"
                type="number"
                min={0}
                value={values.stock}
                onChange={(e) => set("stock", e.target.value)}
                className="mt-1.5"
                aria-invalid={Boolean(errors.stock)}
              />
              {errors.stock && <p className="mt-1 text-xs text-destructive" role="alert">{errors.stock}</p>}
            </div>

            <div>
              <Label htmlFor="pd-low">Low stock alert at</Label>
              <Input id="pd-low" type="number" min={0} value={values.lowStockThreshold} onChange={(e) => set("lowStockThreshold", e.target.value)} className="mt-1.5" />
            </div>

            <div className="sm:col-span-2">
              <Label htmlFor="pd-desc">Description</Label>
              <Textarea id="pd-desc" value={values.description} onChange={(e) => set("description", e.target.value)} rows={3} className="mt-1.5" />
            </div>

            <div>
              <Label htmlFor="pd-tags">Search tags</Label>
              <Input id="pd-tags" value={values.tags} onChange={(e) => set("tags", e.target.value)} className="mt-1.5" placeholder="wireless, earbuds" />
            </div>

            <div>
              <Label htmlFor="pd-slug">URL slug</Label>
              <Input
                id="pd-slug"
                value={values.slug}
                onChange={(e) => set("slug", e.target.value)}
                className="mt-1.5 font-mono text-sm"
                placeholder={values.name ? slugify(values.name) : "auto from name"}
              />
              {errors.slug && <p className="mt-1 text-xs text-destructive" role="alert">{errors.slug}</p>}
            </div>
          </div>

          <div>
            <Label>Images</Label>
            <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
              {values.images.map((url, i) => (
                <div key={`${url}-${i}`} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
                  <Image src={url} alt={`Product image ${i + 1}`} fill sizes="100px" className="object-cover" />
                  <button
                    type="button"
                    onClick={() => set("images", values.images.filter((_, j) => j !== i))}
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-destructive opacity-0 transition group-hover:opacity-100"
                    aria-label={`Remove image ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  {i === 0 && (
                    <span className="absolute bottom-1 left-1 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-bold">Main</span>
                  )}
                </div>
              ))}
              {values.images.length < 8 && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground transition hover:border-primary/50 hover:text-primary disabled:opacity-60"
                >
                  {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                  {uploading ? "Uploading…" : "Upload"}
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0])}
              aria-label="Upload product image"
            />
            <Input
              placeholder="…or paste image URL (/images/products/example.png)"
              className="mt-2 h-9 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) {
                    set("images", [...values.images, v].slice(0, 8));
                    (e.target as HTMLInputElement).value = "";
                  }
                }
              }}
              aria-label="Paste image URL"
            />
            {errors.images && <p className="mt-1 text-xs text-destructive" role="alert">{errors.images}</p>}
          </div>

          <div className="grid gap-4 rounded-xl border bg-muted/30 p-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="pd-status" className="text-xs">Visibility</Label>
              <select id="pd-status" value={values.status} onChange={(e) => set("status", e.target.value as ProductDialogValues["status"])} className={`mt-1.5 ${selectCls}`}>
                <option value="PUBLISHED">Published</option>
                <option value="DRAFT">Draft (hidden)</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
            <div>
              <Label htmlFor="pd-rating" className="text-xs">Display rating (0-5)</Label>
              <Input id="pd-rating" type="number" min={0} max={5} step={0.1} value={values.rating} onChange={(e) => set("rating", e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="pd-reviews" className="text-xs">Review count</Label>
              <Input id="pd-reviews" type="number" min={0} value={values.reviewCount} onChange={(e) => set("reviewCount", e.target.value)} className="mt-1.5" />
            </div>
            <label className="flex cursor-pointer items-center gap-2 sm:col-span-3">
              <Checkbox checked={values.isFeatured} onCheckedChange={(c) => set("isFeatured", c === true)} />
              <span className="text-sm">Feature on homepage</span>
            </label>
          </div>

          {errors._ && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{errors._}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || uploading} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEdit ? "Save Changes" : "Create Product"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
