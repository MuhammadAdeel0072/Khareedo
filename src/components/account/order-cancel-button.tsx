// Customer order cancellation button + confirmation (Phase 3, Chunk 2-final
// — H-11/D1). Shown only for cancellable orders (PENDING / CONFIRMED /
// PROCESSING). The reason is optional and stored on the order when given.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";

export function OrderCancelButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirmCancel() {
    setBusy(true);
    try {
      const res = await fetch(`/api/account/orders/${orderId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast.error(data?.error ?? "Could not cancel this order. Please try again.");
        return;
      }
      setOpen(false);
      toast.success(
        data.alreadyCancelled ? "This order was already cancelled." : "Your order has been cancelled."
      );
      router.refresh();
    } catch {
      toast.error("Could not cancel this order. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Cancel Order
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !o && !busy && setOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
            <AlertDialogDescription>
              Your order will be cancelled and any reserved stock returned to
              inventory. If you used a coupon, its use will be released. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="block text-sm font-medium" htmlFor="cancel-reason">
            Reason (optional)
          </label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Tell us why (optional)"
            maxLength={500}
            rows={3}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep Order</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmCancel();
              }}
            >
              {busy ? "Cancelling…" : "Cancel Order"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
