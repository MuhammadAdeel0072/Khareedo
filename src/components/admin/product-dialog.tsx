"use client";

// Product create/edit dialog (FR-39/40) — opens inline like Add Category.
// SKU is system-assigned server-side; no manual entry field.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Star, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ProductImage } from "@/components/products/product-image";
import { slugify } from "@/lib/utils";
import {
  adminApiErrorMessage,
  readAdminApiResponse,
} from "@/lib/admin-api-response";
import { MAX_PRODUCT_IMAGE_SIZE } from "@/lib/product-image-validation";

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

const INLINE_PRODUCT_ERROR_FIELDS = new Set([
  "name",
  "categoryId",
  "price",
  "comparePrice",
  "images",
  "imageUrl",
  "slug",
  "description",
  "brand",
  "status",
  "rating",
  "reviewCount",
  "tags",
  "stock",
  "lowStockThreshold",
]);

function visibleProductErrors(errors: Record<string, string>) {
  const visible: Record<string, string> = {};
  const summary: string[] = [];

  for (const [field, message] of Object.entries(errors)) {
    if (field === "_" || INLINE_PRODUCT_ERROR_FIELDS.has(field)) {
      visible[field] = message;
    } else {
      summary.push(`${field}: ${message}`);
    }
  }

  if (summary.length) visible._ = [visible._, ...summary].filter(Boolean).join("\n");
  return visible;
}

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
  const [importing, setImporting] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const uploadingRef = useRef(false);
  const importingRef = useRef(false);

  const [previousProps, setPreviousProps] = useState({ open, initial });
  if (previousProps.open !== open || previousProps.initial !== initial) {
    setPreviousProps({ open, initial });
    if (open) {
      setValues(initial);
      setErrors({});
      setImageUrl("");
    }
  }

  function set<K extends keyof ProductDialogValues>(key: K, value: ProductDialogValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function onNameBlur() {
    if (!isEdit && !values.slug && values.name) set("slug", slugify(values.name));
  }

  async function uploadImage(file: File) {
    if (uploadingRef.current || importingRef.current || savingRef.current) return;
    if (values.images.length >= 8) {
      toast.error("A product can have up to eight images.");
      return;
    }
    if (file.size > MAX_PRODUCT_IMAGE_SIZE) {
      toast.error("Image size must not exceed 5 MB.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      toast.error("Only JPEG, PNG, WebP and GIF images are allowed.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    uploadingRef.current = true;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
      const data = await readAdminApiResponse(res);
      if (!res.ok || !data.ok) {
        throw new Error(adminApiErrorMessage(res, data));
      }
      if (!data.url) {
        throw new Error("The upload completed without returning an image URL.");
      }
      const imageUrl = data.url;
      try {
        const url = new URL(imageUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new Error("Invalid image URL protocol");
        }
      } catch {
        throw new Error("The upload returned an invalid image URL.");
      }
      setValues((current) =>
        current.images.length < 8
          ? { ...current, images: [...current.images, imageUrl] }
          : current
      );
      setErrors((current) => {
        const next = { ...current };
        delete next.images;
        delete next.imageUrl;
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Image upload failed");
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function addImageFromUrl() {
    if (importingRef.current || uploadingRef.current || savingRef.current) return;
    const candidate = imageUrl.trim();
    if (values.images.length >= 8) {
      setErrors((current) => ({ ...current, imageUrl: "A product can have up to eight images." }));
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate);
    } catch {
      setErrors((current) => ({ ...current, imageUrl: "Enter a direct HTTPS image URL." }));
      return;
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
      setErrors((current) => ({ ...current, imageUrl: "Enter a direct HTTPS image URL." }));
      return;
    }

    importingRef.current = true;
    setImporting(true);
    setErrors((current) => {
      const next = { ...current };
      delete next.imageUrl;
      return next;
    });
    try {
      const response = await fetch("/api/admin/products/import-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: parsedUrl.toString() }),
      });
      const data = await readAdminApiResponse(response);
      if (!response.ok || !data.ok) {
        const message = data.errors?.imageUrl ?? adminApiErrorMessage(response, data);
        setErrors((current) => ({ ...current, imageUrl: message }));
        toast.error(message);
        return;
      }
      if (!data.url) {
        throw new Error("The import completed without returning an image URL.");
      }

      const importedUrl = new URL(data.url);
      if (importedUrl.protocol !== "https:") {
        throw new Error("The import returned an invalid image URL.");
      }

      setValues((current) =>
        current.images.length < 8
          ? { ...current, images: [...current.images, importedUrl.toString()] }
          : current
      );
      setImageUrl("");
      setErrors((current) => {
        const next = { ...current };
        delete next.images;
        delete next.imageUrl;
        return next;
      });
      toast.success("Image added");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Image import failed";
      setErrors((current) => ({ ...current, imageUrl: message }));
      toast.error(message);
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  function makePrimary(index: number) {
    if (index === 0) return;
    setValues((current) => {
      const images = [...current.images];
      const [primary] = images.splice(index, 1);
      images.unshift(primary);
      return { ...current, images };
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current || uploadingRef.current || importingRef.current) return;
    savingRef.current = true;
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
      const data = await readAdminApiResponse(res);
      if (!res.ok || !data.ok) {
        if (data.errors) {
          setErrors(visibleProductErrors(data.errors));
          toast.error(
            Object.values(data.errors)[0] ?? "Please correct the highlighted fields."
          );
        } else {
          const message = adminApiErrorMessage(res, data);
          setErrors({ _: message });
          toast.error(message);
        }
        return;
      }
      if (!data.product || typeof data.product.id !== "string") {
        setErrors({ _: "The server did not confirm the product was saved. Please try again." });
        toast.error("The server returned an incomplete save response.");
        return;
      }
      toast.success(isEdit ? "Product updated" : "Product created");
      onClose();
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Network error — please try again.";
      setErrors({ _: message });
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const selectCls =
    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !savingRef.current && !uploadingRef.current && !importingRef.current) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Product" : "Add Product"}</DialogTitle>
          <DialogDescription>
            Add product details and images. External images are checked and saved to your product storage.
          </DialogDescription>
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
              {errors.brand && <p className="mt-1 text-xs text-destructive" role="alert">{errors.brand}</p>}
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
              <Input id="pd-low" type="number" min={0} value={values.lowStockThreshold} onChange={(e) => set("lowStockThreshold", e.target.value)} className="mt-1.5" aria-invalid={Boolean(errors.lowStockThreshold)} />
              {errors.lowStockThreshold && <p className="mt-1 text-xs text-destructive" role="alert">{errors.lowStockThreshold}</p>}
            </div>

            <div className="sm:col-span-2">
              <Label htmlFor="pd-desc">Description</Label>
              <Textarea id="pd-desc" value={values.description} onChange={(e) => set("description", e.target.value)} rows={3} className="mt-1.5" aria-invalid={Boolean(errors.description)} />
              {errors.description && <p className="mt-1 text-xs text-destructive" role="alert">{errors.description}</p>}
            </div>

            <div>
              <Label htmlFor="pd-tags">Search tags</Label>
              <Input id="pd-tags" value={values.tags} onChange={(e) => set("tags", e.target.value)} className="mt-1.5" placeholder="wireless, earbuds" aria-invalid={Boolean(errors.tags)} />
              {errors.tags && <p className="mt-1 text-xs text-destructive" role="alert">{errors.tags}</p>}
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
                  <ProductImage
                    src={url}
                    alt={`Product image ${i + 1}`}
                    fill
                    sizes="100px"
                    className="object-cover"
                  />
                  <button
                    type="button"
                    disabled={saving || uploading || importing}
                    onClick={() => setValues((current) => ({
                      ...current,
                      images: current.images.filter((_, j) => j !== i),
                    }))}
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-destructive opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Remove image ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  {i === 0 && (
                    <span className="absolute bottom-1 left-1 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-bold">Main</span>
                  )}
                  {i > 0 && (
                    <button
                      type="button"
                      disabled={saving || uploading || importing}
                      onClick={() => makePrimary(i)}
                      className="absolute bottom-1 left-1 flex h-6 items-center gap-1 rounded bg-background/90 px-1.5 text-[10px] font-medium opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`Make image ${i + 1} the main image`}
                    >
                      <Star className="h-3 w-3" />
                      Make main
                    </button>
                  )}
                </div>
              ))}
              {values.images.length < 8 && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading || importing || saving}
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
            <div className="mt-2 flex gap-2">
              <Input
                id="pd-image-url"
                value={imageUrl}
                onChange={(e) => {
                  setImageUrl(e.target.value);
                  if (errors.imageUrl) {
                    setErrors((current) => {
                      const next = { ...current };
                      delete next.imageUrl;
                      return next;
                    });
                  }
                }}
                placeholder="Paste a direct HTTPS image URL"
                className="h-9 text-xs"
                disabled={saving || uploading || importing}
                aria-invalid={Boolean(errors.imageUrl)}
                aria-describedby={errors.imageUrl ? "pd-image-url-error" : undefined}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addImageFromUrl();
                  }
                }}
              />
              <Button
                type="button"
                variant="secondary"
                className="h-9 shrink-0 gap-1.5"
                onClick={() => void addImageFromUrl()}
                disabled={saving || uploading || importing || !imageUrl.trim() || values.images.length >= 8}
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                {importing ? "Checking…" : "Add Image"}
              </Button>
            </div>
            {errors.imageUrl && (
              <p id="pd-image-url-error" className="mt-1 text-xs text-destructive" role="alert">
                {errors.imageUrl}
              </p>
            )}
            {errors.images && <p className="mt-1 text-xs text-destructive" role="alert">{errors.images}</p>}
          </div>

          <div className="grid gap-4 rounded-xl border bg-muted/30 p-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="pd-status" className="text-xs">Visibility</Label>
              <select id="pd-status" value={values.status} onChange={(e) => set("status", e.target.value as ProductDialogValues["status"])} className={`mt-1.5 ${selectCls}`} aria-invalid={Boolean(errors.status)}>
                <option value="PUBLISHED">Published</option>
                <option value="DRAFT">Draft (hidden)</option>
                <option value="ARCHIVED">Archived</option>
              </select>
              {errors.status && <p className="mt-1 text-xs text-destructive" role="alert">{errors.status}</p>}
            </div>
            <div>
              <Label htmlFor="pd-rating" className="text-xs">Display rating (0-5)</Label>
              <Input id="pd-rating" type="number" min={0} max={5} step={0.1} value={values.rating} onChange={(e) => set("rating", e.target.value)} className="mt-1.5" aria-invalid={Boolean(errors.rating)} />
              {errors.rating && <p className="mt-1 text-xs text-destructive" role="alert">{errors.rating}</p>}
            </div>
            <div>
              <Label htmlFor="pd-reviews" className="text-xs">Review count</Label>
              <Input id="pd-reviews" type="number" min={0} value={values.reviewCount} onChange={(e) => set("reviewCount", e.target.value)} className="mt-1.5" aria-invalid={Boolean(errors.reviewCount)} />
              {errors.reviewCount && <p className="mt-1 text-xs text-destructive" role="alert">{errors.reviewCount}</p>}
            </div>
            <label className="flex cursor-pointer items-center gap-2 sm:col-span-3">
              <Checkbox checked={values.isFeatured} onCheckedChange={(c) => set("isFeatured", c === true)} />
              <span className="text-sm">Feature on homepage</span>
            </label>
          </div>

          {errors._ && (
            <p className="whitespace-pre-line rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{errors._}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={saving || uploading || importing}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || uploading || importing} className="gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEdit ? "Save Changes" : "Create Product"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
