"use client";

// Admin refund UI for one order (Phase 3, H-16). The refund API existed with
// no UI anywhere — this panel lives on the admin order page next to the
// payment diagnostics. Amounts are validated client-side for a fast error,
// but the server re-validates everything from the stored payment ledger, so
// a client mistake can never over-refund.
//
// Refunds only exist for managed Safepay payments: the panel shows only when
// the order has a verified-paid payment (the refundable one) or existing
// refund rows. COD and legacy orders have no refund path and show nothing.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime, formatPKR } from "@/lib/utils";

export type AdminRefundRow = {
  id: string;
  paymentId: string;
  amountMinor: string;
  currency: string;
  type: string;
  status: string;
  providerReference: string | null;
  providerState: string | null;
  failureMessage: string | null;
  reviewReason: string | null;
  requestedAt: string;
  confirmedAt: string | null;
};

export type AdminRefundablePayment = {
  id: string;
  capturedAmountMinor: string;
  refundedAmountMinor: string;
  paidVerifiedAt: string | null;
};

const OPEN_STATUSES = ["REQUESTED", "SUBMITTING", "PENDING"];

function minorToPkr(minor: bigint): number {
  return Number(minor) / 100;
}

export function AdminOrderRefundsPanel({
  payment,
  refunds,
}: {
  payment: AdminRefundablePayment | null;
  refunds: AdminRefundRow[];
}) {
  const router = useRouter();
  const [amountPkr, setAmountPkr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  if (!payment && refunds.length === 0) return null;

  const captured = payment ? BigInt(payment.capturedAmountMinor) : BigInt(0);
  const refunded = payment ? BigInt(payment.refundedAmountMinor) : BigInt(0);
  const open = refunds
    .filter((r) => OPEN_STATUSES.includes(r.status))
    .reduce((sum, r) => sum + BigInt(r.amountMinor), BigInt(0));
  const remaining = captured - refunded - open;
  const remainingPkr = minorToPkr(remaining);
  const paidAt = payment?.paidVerifiedAt ? new Date(payment.paidVerifiedAt) : null;
  const withinReversalWindow =
    paidAt !== null && Date.now() - paidAt.getTime() < 24 * 3_600_000;

  function requestRefund() {
    if (!payment || busy) return;
    const trimmed = amountPkr.trim();
    let amountMinor: number | undefined;
    if (trimmed !== "") {
      const pkr = Number(trimmed);
      if (!Number.isFinite(pkr) || pkr <= 0) {
        setError("Enter an amount greater than Rs 0, or leave it blank for a full refund.");
        return;
      }
      amountMinor = Math.round(pkr * 100);
      if (BigInt(amountMinor) > remaining) {
        setError(`That exceeds the refundable balance of ${formatPKR(remainingPkr)}.`);
        return;
      }
    }
    setError(null);
    setBusy(true);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/payments/refunds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentId: payment.id,
            ...(amountMinor !== undefined ? { amountMinor } : {}),
            idempotencyKey: `ADMIN-${crypto.randomUUID()}`,
          }),
        });
        const payload = await res.json();
        if (!res.ok || !payload.ok) {
          const hint =
            payload.code === "REFUND_EXCEEDS_REMAINING"
              ? "That exceeds the remaining refundable balance."
              : payload.code === "NOTHING_TO_REFUND"
                ? "There is nothing left to refund on this payment."
                : payload.code === "NOT_REFUNDABLE"
                  ? "This payment cannot be refunded in its current state."
                  : payload.error ?? "Refund request failed.";
          throw new Error(hint);
        }
        if (payload.result?.kind === "review_required") {
          toast.warning(
            `Refund parked for review (${payload.result.reason ?? "see the refund row"}). It was not submitted to Safepay.`
          );
        } else if (payload.result?.kind === "existing") {
          toast.info("This refund was already requested — showing the original record.");
        } else {
          toast.success("Refund requested — submission in progress.");
        }
        setAmountPkr("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Refund request failed");
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <div className="mt-4 rounded-xl border bg-card p-5">
      <h2 className="text-sm font-bold">Refunds</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Safepay refunds for this order&apos;s verified payment. Amounts are in
        PKR; leave the amount blank for a full refund of the remaining balance.
        Refunds are sandbox-only by code gate.
      </p>

      {payment && (
        <div className="mt-3 space-y-1 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Captured</span>
            <span className="font-medium">{formatPKR(minorToPkr(captured))}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Already refunded</span>
            <span className="font-medium">{formatPKR(minorToPkr(refunded))}</span>
          </div>
          {open > BigInt(0) && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">In progress</span>
              <span className="font-medium">{formatPKR(minorToPkr(open))}</span>
            </div>
          )}
          <div className="flex justify-between gap-3 border-t pt-1.5">
            <span className="font-semibold">Refundable balance</span>
            <span className="font-bold">{formatPKR(remainingPkr)}</span>
          </div>
        </div>
      )}

      {withinReversalWindow && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Captured less than 24 hours ago — new refund requests are parked for
          review (reversal window) instead of being submitted to Safepay.
        </p>
      )}

      {payment && remaining > BigInt(0) && (
        <form
          className="mt-3 flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            requestRefund();
          }}
        >
          <label className="sr-only" htmlFor="refund-amount">
            Refund amount in PKR (blank for full refund)
          </label>
          <Input
            id="refund-amount"
            inputMode="decimal"
            placeholder={`Amount in PKR (max ${formatPKR(remainingPkr)})`}
            value={amountPkr}
            onChange={(e) => setAmountPkr(e.target.value)}
            className="w-56"
          />
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Requesting…" : "Request refund"}
          </Button>
          {error && <p className="w-full text-xs text-destructive">{error}</p>}
        </form>
      )}

      {refunds.length > 0 && (
        <ul className="mt-4 space-y-2">
          {refunds.map((r) => (
            <li key={r.id} className="rounded-lg border p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">
                  {formatPKR(minorToPkr(BigInt(r.amountMinor)))} · {r.type}
                </span>
                <Badge variant="outline">{r.status}</Badge>
              </div>
              <p className="mt-1 text-muted-foreground">
                Requested {formatDateTime(r.requestedAt)}
                {r.confirmedAt ? ` · confirmed ${formatDateTime(r.confirmedAt)}` : ""}
                {r.providerReference ? ` · provider ref ${r.providerReference}` : ""}
              </p>
              {r.reviewReason && (
                <p className="mt-1 text-amber-700">Parked for review: {r.reviewReason}</p>
              )}
              {r.failureMessage && (
                <p className="mt-1 text-destructive">{r.failureMessage}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
