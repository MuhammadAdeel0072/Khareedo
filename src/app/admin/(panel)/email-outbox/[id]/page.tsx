// Admin email-outbox detail (Phase 3 Chunk 7, H-15). One row: type,
// recipient, status, attempts, last error, next attempt, age — and a retry
// action for FAILED rows. Role + MFA are enforced by the admin panel layout.
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEmailOutboxEntry, emailOutboxOrderReference, emailOutboxTypeLabel } from "@/services/email-outbox.service";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmailOutboxRetryButton } from "@/components/admin/email-outbox-retry-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email outbox entry · Admin" };

export default async function AdminEmailOutboxDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const entry = await getEmailOutboxEntry(id);
  if (!entry) notFound();
  const typeLabel = emailOutboxTypeLabel(entry.type);
  const orderReference = emailOutboxOrderReference(entry.payload);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5">
        <Button variant="outline" asChild>
          <Link href="/admin/email-outbox">← Back to outbox</Link>
        </Button>
      </div>
      <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Outbox entry</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Delivery of a {typeLabel.charAt(0).toLowerCase() + typeLabel.slice(1)} email.
      </p>

      <dl className="mt-6 max-w-2xl space-y-3 rounded-lg border p-4 text-sm sm:p-6">
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="font-semibold">Type</dt>
          <dd>{typeLabel}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="font-semibold">Recipient</dt>
          <dd className="font-mono text-xs">{entry.email}</dd>
        </div>
        {orderReference && (
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="font-semibold">Order</dt>
            <dd className="font-mono text-xs">{orderReference}</dd>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="font-semibold">Status</dt>
          <dd>
            <Badge variant={entry.status === "FAILED" ? "destructive" : "outline"}>
              {entry.status}
            </Badge>
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="font-semibold">Attempts</dt>
          <dd>{entry.attempts} / 5</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="font-semibold">Last error</dt>
          <dd className="text-muted-foreground">{entry.lastError ?? "—"}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="font-semibold">Next attempt</dt>
          <dd>{formatDate(entry.nextAttemptAt)}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="font-semibold">Created</dt>
          <dd>{formatDate(entry.createdAt)}</dd>
        </div>
      </dl>

      {entry.status === "FAILED" && (
        <div className="mt-6 max-w-2xl rounded-lg border p-4 sm:p-6">
          <h2 className="font-semibold">Retry delivery</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Re-enqueues this email with a fresh attempt budget. The worker will deliver it
            shortly; a retry that races a delivery cannot send it twice.
          </p>
          <div className="mt-3">
            <EmailOutboxRetryButton entryId={entry.id} />
          </div>
        </div>
      )}
    </div>
  );
}
