"use client";

// Payment-review queue (Phase 3, H-16). The review API existed with zero
// callers — this is the admin surface for it. Each case is a managed order
// whose checkout closed while a payment may have been payable, so its coupon
// + inventory holds are retained and its review flag is REQUIRED.
//
// Two actions, both guarded server-side; the UI only exposes what the
// service will accept:
//   Investigate — asks Safepay what actually happened (maintenance action).
//     Required before a release can be resolved, unless the attempts never
//     started locally.
//   Resolve — releases the holds (provider never took the money) or accepts
//     the payment as PAID and consumes the holds (provider did take it).
//     A release is blocked while capture evidence exists; a capture
//     resolution is blocked without it. Resolving as captured leaves the
//     order CANCELLED — the money must be refunded or resolved manually next.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldAlert, SearchCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import type { PaymentReviewCase } from "@/services/payment-review.service";

type PendingAction = "investigate" | "resolve-not-captured" | "resolve-captured";

export function PaymentReviewQueue({ cases }: { cases: PaymentReviewCase[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    orderId: string;
    action: Exclude<PendingAction, "investigate">;
  } | null>(null);
  const [, startTransition] = useTransition();

  function run(orderId: string, action: PendingAction) {
    if (busyId) return;
    setBusyId(orderId);
    startTransition(async () => {
      try {
        if (action === "investigate") {
          const res = await fetch("/api/admin/payments/maintenance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "investigate_closed_order_payment",
              orderId,
            }),
          });
          const payload = await res.json();
          if (!res.ok || !payload.ok) {
            throw new Error(payload.error ?? payload.code ?? "Investigation failed");
          }
          if (payload.outcome === "review_required") {
            toast.success("Investigation complete — Safepay was consulted; resolve the hold below.");
          } else if (payload.outcome === "provider_fetch_failed") {
            toast.error(`Safepay could not be reached (${payload.code ?? "unknown"}); try again later.`);
          } else if (payload.outcome === "incomplete_review") {
            toast.warning("Investigation is incomplete — some attempts still need manual review.");
          } else if (payload.outcome === "skipped") {
            toast.info("This order is no longer eligible for investigation.");
          } else {
            toast.info(`Investigation outcome: ${String(payload.outcome)}`);
          }
        } else {
          const outcome =
            action === "resolve-not-captured" ? "NOT_CAPTURED" : "CAPTURED";
          const res = await fetch("/api/admin/payments/review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId, outcome }),
          });
          const payload = await res.json();
          if (!res.ok || !payload.ok) {
            const hint =
              payload.code === "INVESTIGATION_REQUIRED"
                ? "Run Investigate first so Safepay confirms the outcome."
                : payload.code === "CAPTURE_EVIDENCE_PRESENT"
                  ? "Safepay evidence shows money was captured — resolve as captured instead."
                  : payload.code === "CAPTURE_EVIDENCE_REQUIRED"
                    ? "No capture evidence exists — investigate first, or resolve as not captured."
                    : payload.code === "CAPTURE_AMOUNT_MISMATCH"
                      ? "The captured amount does not match the order total — manual review required."
                      : payload.code === "NOT_ELIGIBLE"
                        ? "This order is no longer waiting for review."
                        : payload.error ?? "Could not resolve the hold.";
            throw new Error(hint);
          }
          if (payload.outcome === "RELEASED") {
            toast.success("Hold released — coupon and inventory reservations restored.");
          } else {
            toast.success(
              "Payment accepted as PAID. The order stays cancelled — refund or resolve the money manually next."
            );
          }
          setConfirming(null);
        }
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">
          Payment review
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Managed orders whose checkout closed while a payment may have been
          payable. Their coupon and inventory holds are retained until you
          resolve them — nothing here invents what Safepay did. Investigate
          first, then release the holds or accept the payment.
        </p>
      </div>

      {cases.length === 0 ? (
        <div className="rounded-xl border p-5 text-sm text-muted-foreground">
          No payments are waiting for review.
        </div>
      ) : (
        <ul className="space-y-3">
          {cases.map((c) => {
            const busy = busyId === c.orderId;
            const confirm = confirming?.orderId === c.orderId ? confirming.action : null;
            return (
              <li key={c.orderId} className="rounded-xl border bg-card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link
                      href={`/admin/orders/${c.orderId}`}
                      className="font-mono text-sm font-bold hover:text-primary"
                    >
                      {c.reference}
                    </Link>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.orderStatus} · payment {c.paymentStatus}
                      {c.closedAt ? ` · closed ${formatDateTime(c.closedAt)}` : ""}
                    </p>
                    <p className="mt-1 text-xs">
                      <span className="font-semibold">Review reason: </span>
                      {c.reviewReason ?? "—"}
                      {c.closeReason ? ` · closed as ${c.closeReason}` : ""}
                    </p>
                    {c.reservationExpiresAt && (
                      <p className="text-xs text-muted-foreground">
                        Reservation expired {formatDateTime(c.reservationExpiresAt)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.investigated ? (
                      <Badge variant="outline" className="border-primary/20 bg-brand-50 text-green-800">
                        investigated
                      </Badge>
                    ) : (
                      <Badge variant="outline">not investigated</Badge>
                    )}
                    {c.captureEvidence && (
                      <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                        <ShieldAlert className="mr-1 h-3 w-3" /> capture evidence
                      </Badge>
                    )}
                  </div>
                </div>

                {c.captureEvidence && (
                  <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    Safepay evidence shows money was captured for this order. A
                    release is blocked — resolve it as captured.
                  </p>
                )}

                {confirm ? (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
                    <p className="font-semibold">
                      {confirm === "resolve-not-captured"
                        ? "Release the holds?"
                        : "Accept the payment as PAID?"}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {confirm === "resolve-not-captured"
                        ? "The coupon and inventory reservations are restored and the payment attempts are closed. Only do this if Safepay confirmed no money was taken."
                        : "The reservations are consumed and the payment is accepted as PAID. The order stays cancelled — you must refund or resolve the money manually afterwards."}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => run(c.orderId, confirm)}
                      >
                        {busy ? "Resolving…" : "Confirm"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => run(c.orderId, "investigate")}
                    >
                      <SearchCheck className="mr-1.5 h-3.5 w-3.5" />
                      {busy ? "Working…" : "Investigate"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !c.investigated || c.captureEvidence}
                      title={
                        c.captureEvidence
                          ? "Capture evidence blocks a release — resolve as captured."
                          : !c.investigated
                            ? "Run Investigate first so Safepay confirms the outcome."
                            : undefined
                      }
                      onClick={() =>
                        setConfirming({ orderId: c.orderId, action: "resolve-not-captured" })
                      }
                    >
                      Resolve: not captured
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !c.captureEvidence}
                      title={
                        !c.captureEvidence
                          ? "No capture evidence exists — investigate first, or resolve as not captured."
                          : undefined
                      }
                      onClick={() =>
                        setConfirming({ orderId: c.orderId, action: "resolve-captured" })
                      }
                    >
                      Resolve: captured
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
