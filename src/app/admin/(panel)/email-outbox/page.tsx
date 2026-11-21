// Admin email-outbox viewer (Phase 3 Chunk 7, H-15). Password-reset and
// verification emails are delivered from the outbox in the background; a
// delivery that exhausts its retries used to be visible only in error
// monitoring. This page lists every row still needing attention — PENDING
// and FAILED — with its type, recipient, order reference, attempts, last
// error and age, so a silently failing delivery is visible and a FAILED row
// can be retried. (Stream G: the list used to show the label but not the
// order reference — only the detail page did.)
// Delivered and discarded rows are deleted by the worker, so they never
// appear here. URL is the single source of truth: status and page live in
// the query string. Role + MFA are enforced by the admin panel layout.
import Link from "next/link";
import { listEmailOutboxEntries, EMAIL_OUTBOX_STATUSES, emailOutboxOrderReference, emailOutboxTypeLabel } from "@/services/email-outbox.service";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email outbox · Admin" };

function firstParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function AdminEmailOutboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = firstParam(params.status).trim();
  const page = Number(firstParam(params.page) || "1") || 1;

  const result = await listEmailOutboxEntries({
    status: status || undefined,
    page,
    perPage: 25,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / result.perPage));

  const buildUrl = (parts: { status?: string; page?: number }) => {
    const sp = new URLSearchParams();
    const effectiveStatus = parts.status !== undefined ? parts.status : status;
    if (effectiveStatus) sp.set("status", effectiveStatus);
    if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
    const qs = sp.toString();
    return qs ? `/admin/email-outbox?${qs}` : "/admin/email-outbox";
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Email outbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {result.total} entr{result.total === 1 ? "y" : "ies"} awaiting delivery or failed.
            Delivered emails are removed automatically; failed rows stay here until retried.
          </p>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {["", ...EMAIL_OUTBOX_STATUSES].map((value) => {
          const active = (value || "") === status;
          const label = value === "" ? "All" : value === "PENDING" ? "Pending" : "Failed";
          return (
            <Button key={value || "all"} variant={active ? "default" : "outline"} asChild>
              <Link href={buildUrl({ status: value, page: 1 })}>{label}</Link>
            </Button>
          );
        })}
        {status && (
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/email-outbox">Clear</Link>
          </Button>
        )}
      </div>

      {result.entries.length === 0 ? (
        <p className="rounded-lg border p-6 text-sm text-muted-foreground">
          No outbox entries match these filters. Failed deliveries will appear here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-160 text-left text-sm">
            <thead className="bg-muted/60">
              <tr>
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">Recipient</th>
                <th className="px-3 py-2 font-semibold">Order</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Attempts</th>
                <th className="px-3 py-2 font-semibold">Last error</th>
              </tr>
            </thead>
            <tbody>
              {result.entries.map((entry) => (
                <tr key={entry.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {formatDate(entry.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/email-outbox/${entry.id}`} className="font-medium hover:underline">
                      {emailOutboxTypeLabel(entry.type)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{entry.email}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {emailOutboxOrderReference(entry.payload) ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={entry.status === "FAILED" ? "destructive" : "outline"}>
                      {entry.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">{entry.attempts}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {entry.lastError ?? "—"}
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
