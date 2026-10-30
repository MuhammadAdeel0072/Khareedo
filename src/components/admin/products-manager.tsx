"use client";

// Admin products manager (FR-39) — table + inline Add/Edit dialog (like Categories).
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, Loader2, Pencil, Plus, Search, Upload } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EMPTY_PRODUCT,
  ProductDialog,
  type ProductDialogValues,
} from "@/components/admin/product-dialog";
import { ExportButtons } from "@/components/admin/export-buttons";
import { ImportProductsDialog } from "@/components/admin/import-products-dialog";
import { STATUS_BADGE_CLASSES } from "@/lib/constants";
import { formatPKR, formatDate } from "@/lib/utils";

export interface AdminProductRow {
  id: string;
  name: string;
  slug: string;
  price: number;
  comparePrice: number | null;
  brand: string | null;
  rating: number;
  reviewCount: number;
  image: string | null;
  stock: number;
  isFeatured: boolean;
  status: string;
  createdAt: string | Date;
  categoryName: string;
  categorySlug: string;
}

export function ProductsManager({
  items,
  total,
  pages,
  page,
  q,
  categories,
}: {
  items: AdminProductRow[];
  total: number;
  pages: number;
  page: number;
  q?: string;
  categories: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<ProductDialogValues>(EMPTY_PRODUCT);
  const [draftSku, setDraftSku] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AdminProductRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  function openCreate() {
    setDraftSku(null);
    setDraft({ ...EMPTY_PRODUCT });
    setDialogOpen(true);
  }

  async function openEdit(row: AdminProductRow) {
    setDraftSku(null);
    setDraft({ ...EMPTY_PRODUCT, name: row.name });
    setDialogOpen(true);
    try {
      const res = await fetch(`/api/admin/products/${row.id}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not load product");
      const p = data.product;
      setDraftSku(p.sku);
      setDraft({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description ?? "",
        brand: p.brand ?? "",
        categoryId: p.categoryId,
        price: p.price,
        comparePrice: p.comparePrice,
        status: p.status,
        isFeatured: p.isFeatured,
        rating: p.rating,
        reviewCount: p.reviewCount,
        tags: Array.isArray(p.tags) ? p.tags.join(", ") : (p.tags ?? ""),
        images: (p.images ?? []).map((i: string | { url: string }) => (typeof i === "string" ? i : i.url)).filter(Boolean),
        stock: p.stock ?? 0,
        lowStockThreshold: p.lowStockThreshold ?? 5,
      });
    } catch (e) {
      setDialogOpen(false);
      toast.error(e instanceof Error ? e.message : "Could not load product");
    }
  }

  function confirmArchive() {
    if (!deleting) return;
    const target = deleting;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/products/${target.id}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not archive product");
        toast.success("Product archived");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not archive product");
      } finally {
        setDeleting(null);
      }
    });
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Products</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {total} product{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="gap-1.5" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" /> Import Excel
          </Button>
          <ExportButtons type="products" />
          <Button className="gap-1.5" onClick={openCreate}>
            <Plus className="h-4 w-4" /> Add Product
          </Button>
        </div>
      </div>

      <form action="/admin/products" className="mb-4 flex max-w-sm gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input name="q" defaultValue={q} placeholder="Search products…" className="pl-9" aria-label="Search products" />
        </div>
        <Button type="submit" variant="secondary">Search</Button>
      </form>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Product</th>
              <th className="px-4 py-3 font-semibold">Category</th>
              <th className="px-4 py-3 font-semibold">Price</th>
              <th className="px-4 py-3 font-semibold">Stock</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((p) => (
              <tr key={p.id} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <Image src={p.image ?? "/images/placeholder.svg"} alt="" fill sizes="44px" className="object-cover" />
                    </span>
                    <div className="min-w-0">
                      <p className="max-w-56 truncate font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.brand ?? "—"}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{p.categoryName}</td>
                <td className="px-4 py-3">
                  <span className="font-semibold">{formatPKR(p.price)}</span>
                  {p.comparePrice && p.comparePrice > p.price && (
                    <span className="ml-1.5 text-xs text-muted-foreground line-through">{formatPKR(p.comparePrice)}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={p.stock === 0 ? "font-bold text-red-600" : p.stock <= 5 ? "font-semibold text-amber-600" : ""}>
                    {p.stock}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline" className={STATUS_BADGE_CLASSES[p.status] ?? ""}>
                    {p.status}
                  </Badge>
                  {p.isFeatured && (
                    <Badge variant="outline" className="ml-1 border-primary/40 text-primary">Featured</Badge>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(p)} aria-label={`Edit ${p.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleting(p)}
                      aria-label={`Archive ${p.name}`}
                    >
                      <Archive className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No products found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {items.map((p) => (
          <div key={p.id} className="rounded-xl border bg-card p-3">
            <div className="flex gap-3">
              <span className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                <Image src={p.image ?? "/images/placeholder.svg"} alt="" fill sizes="64px" className="object-cover" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.categoryName}</p>
                <p className="mt-1 font-semibold text-primary">{formatPKR(p.price)}</p>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <Badge variant="outline" className={STATUS_BADGE_CLASSES[p.status] ?? ""}>
                  {p.status}
                </Badge>
                <span className={`text-xs font-semibold ${p.stock === 0 ? "text-red-600" : p.stock <= 5 ? "text-amber-600" : "text-muted-foreground"}`}>
                  Stock: {p.stock}
                </span>
              </div>
            </div>
            <div className="mt-2.5 flex items-center justify-between border-t pt-2.5">
              <span className="text-xs text-muted-foreground">{formatDate(p.createdAt)}</span>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => openEdit(p)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleting(p)}
                >
                  <Archive className="h-3.5 w-3.5" /> Archive
                </Button>
              </div>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">No products found.</p>
        )}
      </div>

      {pages > 1 && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/admin/products?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm font-medium ${
                p === page ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"
              }`}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </Link>
          ))}
        </div>
      )}

      <ProductDialog
        open={dialogOpen}
        initial={draft}
        categories={categories}
        sku={draftSku}
        onClose={() => setDialogOpen(false)}
      />

      <ImportProductsDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive &quot;{deleting?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              It will be removed from the store but kept for order history. Restore anytime by editing its visibility.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                confirmArchive();
              }}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
