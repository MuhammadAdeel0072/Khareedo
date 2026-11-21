"use client";

// Admin order detail — status transitions via the state machine (FR-41, BR-11).
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
import { ProductImage } from "@/components/products/product-image";

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
  carrier: string | null;
  trackingNumber: string | null;
  statusHistory: Array<{
    id: string;
    status: string;
    actor: string | null;
    note: string | null;
    createdAt: string;
  }>;
  items: Array<{
    id: string;
    productName: string;
    variantLabel: string | null;
    productSlug: string | null;
    imageUrl: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    giftWrap: boolean;
  }>;
  userEmail: string | null;
  payments: Array<{
    id: string;
    provider: string;
    amount: number;
    status: string;
    reference: string | null;
    createdAt: string;
  }>;
}

export function AdminOrderView({ order }: { order: AdminOrderDetail }) {
  const router = useRouter();
  const [updating, startTransition] = useTransition();
  const [nextStatus, setNextStatus] = useState<OrderStatus | null>(null);
  // Shipment details (D4): the admin enters carrier/tracking when marking an
  // order SHIPPED, so the Shipped button opens this inline form instead of
  // applying immediately.
  const [shipFormOpen, setShipFormOpen] = useState(false);
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");

  const current = order.status as OrderStatus;
  const allowed = ORDER_STATUS_TRANSITIONS[current] ?? [];

  function applyStatus(status: OrderStatus, fulfilment?: { carrier?: string; trackingNumber?: string }) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/orders/${order.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            ...(fulfilment?.carrier ? { carrier: fulfilment.carrier } : {}),
            ...(fulfilment?.trackingNumber ? { trackingNumber: fulfilment.trackingNumber } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error ?? "Update failed");
        toast.success(`Order moved to ${status}${status === "CANCELLED" ? " — stock restored where applicable" : ""}`);
        setNextStatus(null);
        setShipFormOpen(false);
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
                // SHIPPED asks for carrier/tracking (D4); all other permitted
                // transitions apply immediately (FR-41)
                if (s === "CANCELLED") {
                  setNextStatus(s);
                } else if (s === "SHIPPED") {
                  setShipFormOpen(true);
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
      {/* Shipment details (D4): carrier/tracking are optional — the admin can
          mark the order shipped without them. */}
      {shipFormOpen && allowed.includes("SHIPPED") && (
        <div className="mb-5 rounded-xl border bg-card p-4">
          <h2 className="text-sm font-bold">Shipment details</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Optional — the customer sees the carrier and tracking number on their order page.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium">
              Carrier
              <input
                type="text"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="e.g. TCS, Leopards Courier"
                maxLength={100}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs font-medium">
              Tracking number
              <input
                type="text"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                placeholder="e.g. 1234567890"
                maxLength={100}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={updating}
              onClick={() =>
                applyStatus("SHIPPED", {
                  carrier: carrier.trim() || undefined,
                  trackingNumber: trackingNumber.trim() || undefined,
                })
              }
            >
              {updating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Mark shipped
            </Button>
            <Button size="sm" variant="outline" disabled={updating} onClick={() => setShipFormOpen(false)}>
              Cancel
            </Button>
          </div>
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
                  <ProductImage src={item.imageUrl} alt="" fill sizes="56px" className="object-cover" />
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
                  {item.variantLabel ? (
                    <p className="truncate text-xs text-muted-foreground">{item.variantLabel}</p>
                  ) : null}
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
            {(order.carrier || order.trackingNumber) && (
              <div className="mt-3 space-y-1 border-t pt-3 text-xs">
                <p className="font-semibold">Shipment</p>
                {order.carrier && <p className="text-muted-foreground">Carrier: {order.carrier}</p>}
                {order.trackingNumber && <p className="text-muted-foreground">Tracking: {order.trackingNumber}</p>}
              </div>
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

      {/* Payment history — every payment row for this order, newest first.
          The diagnostics panel above covers managed Safepay payments in
          depth; this is the plain ledger (COD included) the detail page
          previously never showed. */}
      <div className="mt-4 rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-bold">Payment history ({order.payments.length})</h2>
        {order.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments recorded for this order.</p>
        ) : (
          <ul className="space-y-3">
            {order.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 last:border-b-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium">
                    {p.provider === "COD" ? "Cash on Delivery" : p.provider}
                    {p.reference ? <span className="ml-2 font-mono text-xs text-muted-foreground">{p.reference}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(p.createdAt)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className={STATUS_BADGE_CLASSES[p.status] ?? ""}>
                    {p.status}
                  </Badge>
                  <span className="text-sm font-bold">{formatPKR(p.amount)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Status history (M-6) — dated timeline of every transition, oldest
          first. Admins see the actor; customers never do (their page omits
          it). Orders placed before this landed have no rows until their next
          transition. */}
      <div className="mt-4 rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-bold">Status history ({order.statusHistory.length})</h2>
        {order.statusHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No status changes recorded yet — the timeline starts with the next status update.</p>
        ) : (
          <ol className="space-y-3">
            {order.statusHistory.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3 last:border-b-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium">
                    {h.status}
                    {h.note ? <span className="ml-2 font-normal text-muted-foreground">{h.note}</span> : null}
                  </p>
                  {h.actor ? <p className="text-xs text-muted-foreground">by {h.actor}</p> : null}
                </div>
                <p className="text-xs text-muted-foreground">{formatDateTime(h.createdAt)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Cancel confirm */}
      <AlertDialog open={nextStatus === "CANCELLED"} onOpenChange={(o) => !o && setNextStatus(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
            <AlertDialogDescription>
              Cancelling will restore the reserved stock to inventory (this
              order still holds stock). The customer snapshot data is preserved
              for records.
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
