// Admin export actions — plain download links (cookie auth, no client JS needed).
import { FileSpreadsheet, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ExportType = "reports" | "products" | "orders" | "customers";
export type ExportFormat = "xlsx" | "pdf";

export function ExportButtons({
  type,
  formats = ["xlsx", "pdf"],
  className = "",
  scopeQuery = "",
}: {
  type: ExportType;
  formats?: ExportFormat[];
  className?: string;
  /** Active list-filter scope (e.g. "q=…&status=…") applied to order exports. */
  scopeQuery?: string;
}) {
  const scope = scopeQuery ? `&${scopeQuery}` : "";
  const link = (format: ExportFormat, icon: React.ReactNode, label: string) => (
    <Button asChild variant="outline" size="sm" className={`gap-1.5 bg-card ${className}`}>
      <a href={`/api/admin/export?type=${type}&format=${format}${scope}`} download aria-label={`Export ${type} as ${label}`}>
        {icon}
        {label}
      </a>
    </Button>
  );

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={`${type} exports`}>
      {formats.includes("xlsx") &&
        link("xlsx", <FileSpreadsheet className="h-4 w-4 text-emerald-700" />, "Excel")}
      {formats.includes("pdf") &&
        link("pdf", <FileText className="h-4 w-4 text-red-600" />, "PDF")}
    </div>
  );
}
