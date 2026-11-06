"use client";

// Admin order detail — status transitions via the state machine (FR-41, BR-11).
import Image from "next/image";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ORDER_STATUS_TRANSITIONS, STATUS_BADGE_CLASSES, type OrderStatus } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { formatPKR, formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

export interface AdminOrderDetail {
  id: string;
  reference: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  isGuest: boolean;
  shipFullName: string;
  shipPhone: string;
  shipLine1: string;
  shipLine2: string | null;
  shipCity: string;
  shipProvince: string;
  shipPostalCode: string | null;
  subtotal: number;
  discountTotal: number;
  deliveryFee: number;
  deliveryMethod: string;
  giftWrapCharge: number;
  giftWrapSelected: boolean;
  giftWrapMessage: string | null;
  couponCode: string | null;
  total: number;
  notes: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    productName: string;
    productSlug: string | null;
    imageUrl: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    giftWrap: boolean;
  }>;
  userEmail: string | null;
}

export function AdminOrderView({ order }: { order: AdminOrderDetail }) {
  const router = useRouter();
  const [updating, startTransition] = useTransition();
  const [nextStatus, setNextStatus] = useState<OrderStatus | null>(null);

  const current = order.status as OrderStatus;
  const allowed = ORDER_STATUS_TRANSITIONS[current] ?? [];

  function applyStatus(status: OrderStatus) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/orders/${order.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Update failed");
        toast.success(`Order moved to ${status}${status === "CANCELLED" ? " — stock restored where applicable" : ""}`);
        setNextStatus(null);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not update status");
      }
    });
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Button asChild variant="ghost" className="mb-4 -ml-2">
        <Link href="/admin/orders">
          <ArrowLeft className="h-4 w-4" /> All Orders
        </Link>
      </Button>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-xl font-extrabold tracking-tight sm:text-2xl">{order.reference}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Placed {formatDateTime(order.createdAt)} · {order.isGuest ? "Guest checkout" : `Registered customer${order.userEmail ? ` (${order.userEmail})` : ""}`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Badge variant="outline" className={STATUS_BADGE_CLASSES[order.status] ?? ""}>
            {order.status}
          </Badge>
          <Badge variant="outline" className={STATUS_BADGE_CLASSES[order.paymentStatus] ?? ""}>
            {order.paymentMethod === "COD" ? "COD" : order.paymentMethod} · {order.paymentStatus}
          </Badge>
        </div>
      </div>

      {/* Status actions */}
      {allowed.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-4">
          <span className="mr-1 text-sm font-bold">Update status:</span>
          {allowed.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === "CANCELLED" ? "destructive" : "default"}
              onClick={() => {
                // CANCELLED asks for confirmation (stock-restoration consequences);
                // all other permitted transitions apply immediately (FR-41)
                if (s === "CANCELLED") {
                  setNextStatus(s);
                } else {
                  applyStatus(s);
                }
              }}
              disabled={updating}
              className="gap-1.5"
            >
              {updating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      )}
      {allowed.length === 0 && (
        <div className="mb-5 rounded-xl border bg-muted/50 p-4 text-sm text-muted-foreground">
          This order is <strong>{order.status}</strong> — no further status changes are permitted.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Items */}
        <div className="rounded-xl border bg-card p-5 lg:col-span-3">
          <h2 className="mb-4 text-sm font-bold">Items ({order.items.length})</h2>
          <ul className="space-y-3">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3">
                <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                  <Image src={item.imageUrl ?? "/images/placeholder.svg"} alt="" fill sizes="56px" className="object-cover" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {item.productSlug ? (
                      <Link href={`/product/${item.productSlug}`} target="_blank" className="hover:text-primary">
                        {item.productName}
                      </Link>
                    ) : (
                      item.productName
                    )}
                    {item.giftWrap && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                        🎁 Wrap this
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.quantity} × {formatPKR(item.unitPrice)}
                  </p>
                </div>
                <span className="text-sm font-bold">{formatPKR(item.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <Separator className="my-4" />
          <div className="space-y-2 text-sm">
            <Row label="Subtotal" value={formatPKR(order.subtotal)} />
            {order.discountTotal > 0 && <Row label={`Discount${order.couponCode ? ` (${order.couponCode})` : ""}`} value={`− ${formatPKR(order.discountTotal)}`} accent />}
            <Row label={`Delivery (${order.deliveryMethod === "EXPRESS" ? "Express" : "Standard"})`} value={order.deliveryFee === 0 ? "FREE" : formatPKR(order.deliveryFee)} />
            {order.giftWrapCharge > 0 && <Row label="Gift Wrapping" value={formatPKR(order.giftWrapCharge)} />}
            <div className="flex justify-between border-t pt-2.5 text-base">
              <span className="font-bold">Total</span>
              <span className="font-extrabold text-primary">{formatPKR(order.total)}</span>
            </div>
          </div>
        </div>

        {/* Customer + delivery */}
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-xl border bg-card p-5">
            <h2 className="text-sm font-bold">Customer</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              <span className="font-medium text-foreground">{order.customerName}</span>
              <br />
              {order.customerEmail}
              <br />
              {order.customerPhone}
            </p>
          </div>
          <div className="rounded-xl border bg-card p-5">
            <h2 className="text-sm font-bold">Delivery Address</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              <span className="font-medium text-foreground">{order.shipFullName}</span> · {order.shipPhone}
              <br />
              {order.shipLine1}
              {order.shipLine2 ? `, ${order.shipLine2}` : ""}
              <br />
              {order.shipCity}, {order.shipProvince} {order.shipPostalCode ?? ""}
            </p>
            {order.giftWrapSelected && (
              <p className="mt-3 rounded-lg bg-brand-50 p-2.5 text-xs">
                🎁 <span className="font-semibold">
                  Gift wrapped ({order.items.filter((i) => i.giftWrap).length} of {order.items.length} item
                  {order.items.length === 1 ? "" : "s"})
                </span>
                {order.giftWrapMessage ? ` — note: "${order.giftWrapMessage}"` : ""}
              </p>
            )}
          </div>
          {order.notes && (
            <div className="rounded-xl border bg-card p-5">
              <h2 className="text-sm font-bold">Customer Notes</h2>
              <p className="mt-2 text-sm text-muted-foreground">{order.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* Cancel confirm */}
      <AlertDialog open={nextStatus === "CANCELLED"} onOpenChange={(o) => !o && setNextStatus(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
            <AlertDialogDescription>
              Cancelling will restore the reserved stock to inventory
              {current === "SHIPPED" ? "" : " (this order still holds stock)"}. The customer
              snapshot data is preserved for records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Order</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                applyStatus("CANCELLED");
              }}
            >
              Cancel Order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-semibold", accent && "text-primary")}>{value}</span>
    </div>
  );
}
