// Admin audit-log viewer (PR-12). Append-only record of security-relevant
// admin actions (MFA lifecycle, product/category/inventory/order/refund/
// payment/settings changes, exports). URL is the single source of truth:
// action, targetType and page all live in the query string. Read-only:
// there is no way to edit or delete a record from this page or any API.
import Link from "next/link";
import { listAdminAuditLogs } from "@/services/admin-audit.service";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit log · Admin" };

function firstParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function AdminAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const action = firstParam(params.action).trim();
  const targetType = firstParam(params.targetType).trim();
  const page = Number(firstParam(params.page) || "1") || 1;

  const result = await listAdminAuditLogs({
    action: action || undefined,
    targetType: targetType || undefined,
    page,
    perPage: 25,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / result.perPage));

  const buildUrl = (parts: { action?: string; targetType?: string; page?: number }) => {
    const sp = new URLSearchParams();
    const effectiveAction = parts.action !== undefined ? parts.action : action;
    const effectiveTargetType = parts.targetType !== undefined ? parts.targetType : targetType;
    if (effectiveAction) sp.set("action", effectiveAction);
    if (effectiveTargetType) sp.set("targetType", effectiveTargetType);
    if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
    const qs = sp.toString();
    return qs ? `/admin/audit-log?${qs}` : "/admin/audit-log";
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Audit log</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {result.total} record{result.total === 1 ? "" : "s"}. Append-only: records are
            never edited or deleted through the app.
          </p>
        </div>
      </div>

      <form method="get" action="/admin/audit-log" className="mb-5 flex flex-wrap gap-2">
        <Input
          name="action"
          defaultValue={action}
          placeholder="Filter by action, e.g. admin.order.status_changed"
          className="min-w-56 flex-1"
        />
        <Input
          name="targetType"
          defaultValue={targetType}
          placeholder="Filter by resource, e.g. Order"
          className="min-w-40 flex-1"
        />
        <Button type="submit">Filter</Button>
        {(action || targetType) && (
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/audit-log">Clear</Link>
          </Button>
        )}
      </form>

      {result.entries.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          No audit records match these filters yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-160 text-left text-sm">
            <thead className="bg-muted/60">
              <tr>
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Admin</th>
                <th className="px-3 py-2 font-semibold">Action</th>
                <th className="px-3 py-2 font-semibold">Target</th>
                <th className="px-3 py-2 font-semibold">IP</th>
              </tr>
            </thead>
            <tbody>
              {result.entries.map((entry) => (
                <tr key={entry.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {formatDate(entry.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    {entry.adminEmail ?? entry.adminUserId ?? "Unknown"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{entry.action}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {entry.targetType}
                    {entry.targetId ? (
                      <span className="block font-mono text-xs text-muted-foreground">
                        {entry.targetId}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {entry.ipAddress ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center gap-2">
          {page > 1 && (
            <Button variant="outline" asChild>
              <Link href={buildUrl({ page: page - 1 })}>Previous</Link>
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Button variant="outline" asChild>
              <Link href={buildUrl({ page: page + 1 })}>Next</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
