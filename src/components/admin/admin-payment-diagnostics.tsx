"use client";

// Read-only Safepay payment diagnostics for the admin order detail page (audit §7).
// Shows the verification/reconciliation state that determines whether the order can be
// fulfilled, plus a single guarded action: re-check THIS payment with Safepay. The
// action is not a manual override — it triggers a server-side reporter lookup and the
// outcome is whatever authenticated provider evidence supports. Unverified payments can
// never be marked paid from here, and no secret, tracker token or raw payload is shown.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { STATUS_BADGE_CLASSES } from "@/lib/constants";
import { formatDateTime, formatPKR } from "@/lib/utils";
import type { AdminPaymentDiagnostics } from "@/services/admin-payment-diagnostics.service";

function minorToPkr(minor: string | null): string {
  if (minor === null) return "—";
  try { return formatPKR(Number(BigInt(minor)) / 100); } catch { return "—"; }
}

function Bool({ value }: { value: boolean }) {
  return value
    ? <span className="font-semibold text-green-700">Yes</span>
    : <span className="text-muted-foreground">No</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs font-medium">{children}</span>
    </div>
  );
}

export function AdminPaymentDiagnosticsPanel({ data }: { data: AdminPaymentDiagnostics }) {
  const router = useRouter();
  const [checking, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const latest = data.payments[data.payments.length - 1];

  function recheck() {
    if (!data.canRecheck || busy) return;
    setBusy(true);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/payments/maintenance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "verify_order_payment", orderId: data.order.id }),
        });
        const payload = await res.json();
        if (!res.ok || !payload.ok) throw new Error(payload.error ?? "Re-check failed");
        if (payload.outcome === "settled") toast.success("Safepay verified the payment — order is now PAID and confirmed.");
        else if (payload.outcome === "already_settled") toast.success("Payment already verified earlier — nothing changed.");
        else if (payload.outcome === "recorded") toast.info("Safepay reports the payment is still in progress; a retry is scheduled.");
        else if (payload.outcome === "review_required") toast.warning("Safepay evidence requires manual review — see the review reason below.");
        else if (payload.outcome === "provider_fetch_failed") toast.error(`Safepay could not be reached (${payload.code}); a retry was scheduled.`);
        else if (payload.outcome === "quarantined") toast.warning("Safepay's response could not be authenticated and was parked for review.");
        else toast.info(`Re-check outcome: ${String(payload.outcome)}`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not re-check the payment");
      } finally {
        setBusy(false);
      }
    });
  }

  const verified = latest?.status === "PAID" && latest?.reconcileStatus === "VERIFIED";

  return (
    <div className="mt-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-bold">
          <ShieldCheck className="h-4 w-4 text-primary" /> Safepay payment diagnostics
        </h2>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={STATUS_BADGE_CLASSES[latest?.status ?? ""] ?? ""}>
            {latest?.status ?? "—"}
          </Badge>
          {verified && <Badge variant="outline" className="border-green-200 bg-green-50 text-green-800">verified</Badge>}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Read-only view of the managed hosted-checkout lifecycle. Fulfilment stays locked until Safepay evidence
        verifies the payment and reservations are consumed.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        <div>
          <Row label="Provider / environment"><span>Safepay · {latest?.providerEnvironment ?? "—"}</span></Row>
          <Row label="Attempt">{latest?.attemptNumber ?? "—"}{latest?.attemptState ? ` · ${latest.attemptState}` : ""}</Row>
          <Row label="Tracker bound"><Bool value={Boolean(latest?.hasBoundTracker)} /></Row>
          <Row label="Amount">{formatPKR(latest?.amount ?? data.order.total)} {data.order.currency}</Row>
          <Row label="Expected / captured">{minorToPkr(latest?.expectedAmountMinor ?? null)} / {minorToPkr(latest?.capturedAmountMinor ?? null)}</Row>
          <Row label="Verified at">{latest?.paidVerifiedAt ? formatDateTime(latest.paidVerifiedAt) : "—"}</Row>
          <Row label="Reconciliation">{latest?.reconcileStatus ?? "—"}</Row>
        </div>
        <div>
          <Row label="Last re-check">{latest?.lastReconcileAt ? formatDateTime(latest.lastReconcileAt) : "—"}</Row>
          <Row label="Next scheduled re-check">{latest?.nextReconcileAt ? formatDateTime(latest.nextReconcileAt) : "—"}</Row>
          <Row label="Re-check attempts">{latest?.reconcileAttempts ?? 0}</Row>
          <Row label="Last error code">{latest?.lastErrorCode ?? "—"}</Row>
          <Row label="Review status">{data.order.paymentReviewStatus ?? "—"}{data.order.paymentReviewReason ? ` · ${data.order.paymentReviewReason}` : ""}</Row>
          <Row label="Reservation window">{data.order.reservationExpiresAt ? formatDateTime(data.order.reservationExpiresAt) : "—"}</Row>
          <Row label="Coupon reservation">{data.order.couponCode ? `${data.order.couponCode} · ${data.couponReservationState ?? "—"}` : "none"}</Row>
        </div>
      </div>

      <Separator className="my-3" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-bold">Inventory reservations</h3>
          <ul className="mt-1 space-y-0.5">
            {data.reservations.map((r, i) => (
              <li key={i} className="flex justify-between text-xs">
                <span className="truncate text-muted-foreground">{r.quantity} × {r.productName}</span>
                <span className="font-medium">{r.state ?? "—"}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-bold">Webhook / reconciliation events</h3>
          {data.webhookEvents.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No signed Safepay events received for this payment yet.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {data.webhookEvents.map((e, i) => (
                <li key={i} className="flex justify-between gap-2 text-xs">
                  <span className="truncate text-muted-foreground">
                    {e.eventType ?? "event"} · {e.firstReceivedAt ? formatDateTime(e.firstReceivedAt) : ""}
                  </span>
                  <span className="font-medium">
                    {e.processingStatus}{e.reviewRequired ? ` · ${e.reviewReason ?? "review"}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-3 text-xs font-bold">Recent verification evidence</h3>
          {data.evidence.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No evidence recorded yet.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {data.evidence.slice(0, 4).map((e, i) => (
                <li key={i} className="flex justify-between gap-2 text-xs">
                  <span className="truncate text-muted-foreground">{e.operation} · {e.source}</span>
                  <span className="font-medium">{e.decision}{e.reasonCode ? ` · ${e.reasonCode}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Separator className="my-3" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-md text-xs text-muted-foreground">
          Re-check performs one server-side verification with Safepay for this payment. It cannot mark an
          unverified payment as paid and never bypasses reservation checks.
        </p>
        <Button size="sm" variant="outline" onClick={recheck} disabled={!data.canRecheck || busy || checking}
          className="gap-1.5">
          {busy || checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Re-check payment with Safepay
        </Button>
      </div>
      {!data.canRecheck && !verified && (
        <p className="mt-2 text-xs text-muted-foreground">
          Re-checking is unavailable while the order is closed, another payment was accepted, or review is
          required. Resolve the review reason first.
        </p>
      )}
    </div>
  );
}
