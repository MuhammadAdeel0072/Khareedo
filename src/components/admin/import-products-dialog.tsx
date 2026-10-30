"use client";

// Bulk product import from Excel — upload dialog with per-row result feedback.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ImportResult {
  created: number;
  skipped: number;
  failed: number;
  totalRows: number;
  errors: Array<{ rowNumber: number | null; message: string }>;
}

export function ImportProductsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function reset() {
    setFile(null);
    setResult(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/import/products", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Import failed");
      setResult(data as ImportResult);
      if (data.created > 0) {
        toast.success(`${data.created} product${data.created === 1 ? "" : "s"} imported`);
        router.refresh();
      } else {
        toast.warning("Nothing was imported — see the details below");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import products from Excel</DialogTitle>
          <DialogDescription>
            Upload an .xlsx file — up to 200 rows per import. Products whose name already exists are skipped, so re-uploads are safe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <a
            href="/api/admin/import/products/template"
            download
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            <Download className="h-4 w-4" /> Download the template first
          </a>

          <Input
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
            disabled={busy}
            aria-label="Excel file to import"
          />

          {result && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm" role="status">
              <p className="font-semibold">
                <span className="text-emerald-700">{result.created} created</span>
                <span className="mx-1.5 text-muted-foreground">·</span>
                <span className="text-amber-600">{result.skipped} skipped</span>
                <span className="mx-1.5 text-muted-foreground">·</span>
                <span className="text-red-600">{result.failed} failed</span>
              </p>
              {result.errors.length > 0 && (
                <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-4 text-xs text-muted-foreground">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      {e.rowNumber ? `Row ${e.rowNumber}: ` : ""}
                      {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={handleClose} disabled={busy}>
            Close
          </Button>
          <Button onClick={upload} disabled={!file || busy} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
