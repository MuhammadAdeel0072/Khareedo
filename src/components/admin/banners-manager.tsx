"use client";

// Admin banners manager (FR-42, FR-51) — hero/side/strip promotional content.
// Image workflow (Task: dynamic banner management): upload from the admin's
// computer (drag-drop + progress, stored persistently via /api/admin/upload)
// OR paste an external image URL (with live preview, load feedback and an
// optional server-side "download & store permanently" import). No storage
// paths, no code changes, no redeploy — ever.
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  DownloadCloud,
  ImageIcon,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { BannerImage } from "@/components/home/banner-image";

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

const PLACEMENT_HINT: Record<string, string> = {
  HERO: "Wide image recommended — around 1600×630 (2.5:1).",
  SIDE: "Landscape image recommended — around 800×500.",
  STRIP: "Wide, short image recommended.",
};

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type ImageMode = "upload" | "url";

interface UploadState {
  uploading: boolean;
  progress: number;
  fileName: string | null;
  fileSize: number | null;
  error: string | null;
}

const IDLE_UPLOAD: UploadState = { uploading: false, progress: 0, fileName: null, fileSize: null, error: null };

function isSafeLocalReference(value: string): boolean {
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Uploaded/storage URLs are persistent assets; everything else came from the URL tab. */
function looksPersistent(value: string): boolean {
  return value.startsWith("/") || value.includes("/storage/v1/object/public/");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function BannersManager({ initial }: { initial: AdminBanner[] }) {
  const router = useRouter();
  const banners = initial;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AdminBanner | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();

  // Image-source workflow state
  const [imageMode, setImageMode] = useState<ImageMode>("upload");
  const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD);
  const [urlPreviewError, setUrlPreviewError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  function openCreate() {
    setErrors({});
    setUpload(IDLE_UPLOAD);
    setUrlPreviewError(null);
    setImageMode("upload"); // Upload is the recommended default
    setDraft({ id: null, title: "", subtitle: "", imageUrl: "", linkUrl: "/products", placement: "HERO", isActive: true, sortOrder: banners.length + 1 });
  }
  function openEdit(b: AdminBanner) {
    setErrors({});
    setUpload(IDLE_UPLOAD);
    setUrlPreviewError(null);
    setImageMode(looksPersistent(b.imageUrl) ? "upload" : "url");
    setDraft({ id: b.id, title: b.title, subtitle: b.subtitle ?? "", imageUrl: b.imageUrl, linkUrl: b.linkUrl ?? "", placement: b.placement, isActive: b.isActive, sortOrder: b.sortOrder });
  }

  function closeDraft() {
    if (upload.uploading) {
      xhrRef.current?.abort();
      setUpload(IDLE_UPLOAD);
    }
    setDraft(null);
  }

  // ─── Client-side file validation (server re-validates magic bytes + size) ───
  function validateFile(file: File): string | null {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      return "Unsupported format — please choose a JPG, PNG, WebP or GIF image.";
    }
    if (file.size === 0) return "The selected file is empty.";
    if (file.size > MAX_UPLOAD_BYTES) return "The image is larger than 5 MB — please choose a smaller file.";
    return null;
  }

  // ─── Upload via XHR (progress events) to the existing admin upload API ───
  function uploadFile(file: File) {
    if (!draft) return;
    const validationError = validateFile(file);
    if (validationError) {
      setUpload({ ...IDLE_UPLOAD, error: validationError });
      return;
    }

    setUrlPreviewError(null);
    setUpload({ uploading: true, progress: 0, fileName: file.name, fileSize: file.size, error: null });

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/api/admin/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUpload((prev) => ({ ...prev, progress: Math.round((e.loaded / e.total) * 100) }));
      }
    };
    xhr.onload = () => {
      xhrRef.current = null;
      try {
        const data = JSON.parse(xhr.responseText) as { ok?: boolean; url?: string; error?: string };
        if (xhr.status === 200 && data.ok && data.url) {
          setUpload({ uploading: false, progress: 100, fileName: file.name, fileSize: file.size, error: null });
          setDraft((prev) => (prev ? { ...prev, imageUrl: data.url! } : prev));
          setErrors((prev) => ({ ...prev, imageUrl: "" }));
          toast.success("Image uploaded — remember to save the banner.");
        } else {
          setUpload((prev) => ({ ...prev, uploading: false, progress: 0, error: data.error ?? "Upload failed. Please try again." }));
        }
      } catch {
        setUpload((prev) => ({ ...prev, uploading: false, progress: 0, error: "Upload failed. Please try again." }));
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setUpload((prev) => ({ ...prev, uploading: false, progress: 0, error: "Network error during upload. Please try again." }));
    };
    xhr.onabort = () => {
      xhrRef.current = null;
      setUpload(IDLE_UPLOAD);
    };

    const formData = new FormData();
    formData.append("file", file);
    formData.append("target", "banner");
    xhr.send(formData);
  }

  // ─── Server-side import of an external image URL (SSRF-guarded) ───
  async function importExternalImage() {
    if (!draft || !draft.imageUrl || importing) return;
    setImporting(true);
    try {
      const res = await fetch("/api/admin/banners/import-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: draft.imageUrl }),
      });
      const data = await res.json();
      if (res.ok && data.ok && data.url) {
        setDraft((prev) => (prev ? { ...prev, imageUrl: data.url } : prev));
        setImageMode("upload");
        setUpload({ ...IDLE_UPLOAD, fileName: "Imported from external URL" });
        toast.success("Image stored permanently — it now lives in your own storage.");
      } else {
        toast.error(data.error ?? "Could not import the image.");
      }
    } catch {
      toast.error("Network error while importing the image.");
    } finally {
      setImporting(false);
    }
  }

  function removeImage() {
    if (!draft) return;
    setDraft({ ...draft, imageUrl: "" });
    setUpload(IDLE_UPLOAD);
    setUrlPreviewError(null);
  }

  function validateDraft(d: Draft): Record<string, string> {
    const next: Record<string, string> = {};
    if (d.title.trim().length < 2) next.title = "Title is required (at least 2 characters)";
    if (!d.imageUrl.trim()) next.imageUrl = "Please upload an image or provide an image URL";
    else if (!isSafeLocalReference(d.imageUrl.trim())) next.imageUrl = "Use an uploaded image or an http(s) image URL";
    if (d.linkUrl.trim() && !isSafeLocalReference(d.linkUrl.trim())) next.linkUrl = "Link must be a site path (e.g. /products) or an http(s) URL";
    const sort = Number(d.sortOrder);
    if (!Number.isInteger(sort) || sort < 0) next.sortOrder = "Sort order must be a whole number of 0 or more";
    return next;
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || saving || upload.uploading || importing) return;
    const nextErrors = validateDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
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

  const previewUrl = draft?.imageUrl.trim() ?? "";
  const busy = saving || upload.uploading || importing;

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
                      <BannerImage src={b.imageUrl} alt="" className="h-full w-full object-cover" />
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

      <Dialog open={draft !== null} onOpenChange={(o) => !o && closeDraft()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit Banner" : "Add Banner"}</DialogTitle>
            <DialogDescription>
              Upload an image from your computer or use an image URL. Saved banners appear on the storefront immediately.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form onSubmit={save} className="space-y-3" noValidate>
              <div>
                <Label htmlFor="banner-title">Title *</Label>
                <Input
                  id="banner-title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className="mt-1.5"
                  aria-invalid={Boolean(errors.title)}
                  maxLength={120}
                />
                {errors.title && <p className="mt-1 text-xs text-destructive" role="alert">{errors.title}</p>}
              </div>
              <div>
                <Label htmlFor="banner-subtitle">Subtitle</Label>
                <Input id="banner-subtitle" value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} className="mt-1.5" maxLength={200} />
              </div>

              {/* ─── Image source: Upload File (recommended) | Image URL ─── */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <Label>Image *</Label>
                  <div className="flex rounded-lg border bg-muted/40 p-0.5" role="tablist" aria-label="Image source">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={imageMode === "upload"}
                      onClick={() => setImageMode("upload")}
                      className={cn(
                        "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition",
                        imageMode === "upload" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" /> Upload File
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={imageMode === "url"}
                      onClick={() => setImageMode("url")}
                      className={cn(
                        "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition",
                        imageMode === "url" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> Image URL
                    </button>
                  </div>
                </div>

                {imageMode === "upload" ? (
                  <div className="space-y-2">
                    {!draft.imageUrl && (
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label="Choose an image file to upload"
                        onClick={() => !upload.uploading && fileInputRef.current?.click()}
                        onKeyDown={(e) => {
                          if ((e.key === "Enter" || e.key === " ") && !upload.uploading) {
                            e.preventDefault();
                            fileInputRef.current?.click();
                          }
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragActive(true);
                        }}
                        onDragLeave={() => setDragActive(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragActive(false);
                          if (!upload.uploading) {
                            const file = e.dataTransfer.files?.[0];
                            if (file) uploadFile(file);
                          }
                        }}
                        className={cn(
                          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-6 text-center transition",
                          dragActive ? "border-primary bg-brand-50" : "border-muted-foreground/25 hover:border-primary/50",
                          upload.uploading && "pointer-events-none opacity-70"
                        )}
                      >
                        {upload.uploading ? (
                          <Loader2 className="h-7 w-7 animate-spin text-primary" aria-hidden="true" />
                        ) : (
                          <ImageIcon className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
                        )}
                        <p className="text-sm font-semibold">
                          {upload.uploading ? `Uploading… ${upload.progress}%` : "Click to choose an image or drop it here"}
                        </p>
                        <p className="text-xs text-muted-foreground">JPG, PNG, WebP or GIF · up to 5 MB</p>
                        {upload.uploading && (
                          <div className="mt-1 h-1.5 w-56 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${upload.progress}%` }} />
                          </div>
                        )}
                        <p className="text-[11px] text-muted-foreground">
                          {PLACEMENT_HINT[draft.placement]}
                        </p>
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={ACCEPTED_IMAGE_TYPES.join(",")}
                      className="hidden"
                      aria-label="Choose image file"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) uploadFile(file);
                        e.target.value = ""; // allow re-choosing the same file
                      }}
                    />
                    {upload.error && (
                      <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> {upload.error}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Input
                      value={draft.imageUrl}
                      onChange={(e) => {
                        setDraft({ ...draft, imageUrl: e.target.value });
                        setUrlPreviewError(null);
                      }}
                      placeholder="https://example.com/banner.jpg"
                      aria-label="Image URL"
                      aria-invalid={Boolean(errors.imageUrl)}
                      inputMode="url"
                      spellCheck={false}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Paste a direct link to an image. After previewing it you can store a copy in your own media library so it never breaks.
                    </p>
                  </div>
                )}
                {errors.imageUrl && (
                  <p className="mt-1 text-xs text-destructive" role="alert">{errors.imageUrl}</p>
                )}

                {previewUrl && (
                  <div className="mt-2 space-y-2">
                    <span className="relative block aspect-[2.4/1] overflow-hidden rounded-lg border bg-muted">
                      {/* Live preview uses a plain <img> so arbitrary admin-pasted hosts render without a next/image allowlist. */}
                      <img
                        src={previewUrl}
                        alt="Selected banner preview"
                        className="absolute inset-0 h-full w-full object-cover"
                        onError={() => setUrlPreviewError("This image could not be loaded — check the URL or upload a file instead.")}
                      />
                    </span>
                    {urlPreviewError && (
                      <p className="flex items-center gap-1.5 text-xs text-destructive" role="alert">
                        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> {urlPreviewError}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                          looksPersistent(previewUrl) ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                        )}
                      >
                        {looksPersistent(previewUrl) ? "Stored in your media library" : "External URL — can break if the host removes it"}
                      </span>
                      {upload.fileName && (
                        <span className="text-[11px] text-muted-foreground">
                          {upload.fileName}
                          {upload.fileSize ? ` · ${formatBytes(upload.fileSize)}` : ""}
                        </span>
                      )}
                      <div className="ml-auto flex flex-wrap gap-1.5">
                        {!looksPersistent(previewUrl) && (
                          <Button type="button" variant="outline" size="sm" onClick={importExternalImage} disabled={busy} className="gap-1.5">
                            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <DownloadCloud className="h-3.5 w-3.5" aria-hidden="true" />}
                            Store permanently
                          </Button>
                        )}
                        <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={upload.uploading}>
                          Replace
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={removeImage}
                          disabled={upload.uploading}
                          className="gap-1 text-destructive hover:text-destructive"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" /> Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="banner-placement">Placement</Label>
                  <select
                    id="banner-placement"
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
                  <Label htmlFor="banner-sort">Sort order</Label>
                  <Input id="banner-sort" type="number" min={0} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} className="mt-1.5" aria-invalid={Boolean(errors.sortOrder)} />
                  {errors.sortOrder && <p className="mt-1 text-xs text-destructive" role="alert">{errors.sortOrder}</p>}
                </div>
              </div>
              <div>
                <Label htmlFor="banner-link">Link URL</Label>
                <Input id="banner-link" value={draft.linkUrl} onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} className="mt-1.5" placeholder="/products?category=..." aria-invalid={Boolean(errors.linkUrl)} />
                {errors.linkUrl && <p className="mt-1 text-xs text-destructive" role="alert">{errors.linkUrl}</p>}
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={draft.isActive} onCheckedChange={(c) => setDraft({ ...draft, isActive: c === true })} />
                <span className="text-sm">Active — visible on storefront</span>
              </label>
              {errors._ && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{errors._}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={closeDraft}>Cancel</Button>
                <Button type="submit" disabled={busy} className="gap-2">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {upload.uploading ? "Uploading image…" : draft.id ? "Save Changes" : "Create Banner"}
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
            <AlertDialogDescription>
              This banner will be removed from the storefront immediately.
              {deleting && looksPersistent(deleting.imageUrl)
                ? " Its uploaded image file is cleaned up automatically if no other banner uses it."
                : ""}
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
