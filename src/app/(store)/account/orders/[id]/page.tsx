// Customer order detail + status tracking (FR-26). Ownership enforced server-side.
import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2, Circle, PackageCheck, Truck } from "lucide-react";
import { getOrderById } from "@/services/orders.service";
import { getSessionUser } from "@/lib/auth-guard";
import { formatPKR, formatDateTime } from "@/lib/utils";
import { STATUS_BADGE_CLASSES, ORDER_STATUSES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order Details" };

const TRACK_STEPS = ["CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] as const;

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?callbackUrl=/account/orders");
  const { id } = await params;

  const order = await getOrderById(id);
  // NFR-11 — customers may only view their own orders
  if (!order || order.userId !== user.id) notFound();

  const cancelled = order.status === "CANCELLED";
  const currentStep = TRACK_STEPS.indexOf(order.status as (typeof TRACK_STEPS)[number]);

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-xl font-extrabold tracking-tight sm:text-2xl">{order.reference}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Placed {formatDateTime(order.createdAt)}</p>
        </div>
        <Badge variant="outline" className={STATUS_BADGE_CLASSES[order.status] ?? ""}>
          {order.status}
        </Badge>
      </div>

      {/* Status tracker */}
      {cancelled ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          This order was cancelled. Any authorised refunds follow our store policy — contact us if
          you have questions.
        </div>
      ) : (
        <div className="mb-4 rounded-xl border p-5">
          <h2 className="mb-4 text-sm font-bold">Order Progress</h2>
          <ol className="flex items-start justify-between" aria-label="Order progress">
            {TRACK_STEPS.map((s, i) => {
              const done = currentStep >= i;
              const isCurrent = currentStep === i;
              return (
                <li key={s} className="flex flex-1 flex-col items-center text-center">
                  <span className="flex items-center w-full">
                    <span className={cn("h-0.5 flex-1", i === 0 ? "bg-transparent" : currentStep >= i ? "bg-primary" : "bg-muted")} />
                    {done ? (
                      <CheckCircle2 className={cn("h-6 w-6 shrink-0", isCurrent ? "text-primary" : "text-primary/60")} aria-hidden="true" />
                    ) : (
                      <Circle className="h-6 w-6 shrink-0 text-muted-foreground/30" aria-hidden="true" />
                    )}
                    <span className={cn("h-0.5 flex-1", i === TRACK_STEPS.length - 1 ? "bg-transparent" : currentStep > i ? "bg-primary" : "bg-muted")} />
                  </span>
                  <span className={cn("mt-1.5 text-[11px] font-medium capitalize", done ? "text-foreground" : "text-muted-foreground")}>
                    {s.toLowerCase()}
                  </span>
                </li>
              );
            })}
          </ol>
          {order.status === "SHIPPED" && (
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Truck className="h-3.5 w-3.5" /> Your order is on the way!
            </p>
          )}
        </div>
      )}

      {/* Items */}
      <div className="rounded-xl border p-5">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-bold">
          <PackageCheck className="h-4 w-4 text-primary" aria-hidden="true" /> Items ({order.items.length})
        </h2>
        <ul className="space-y-3">
          {order.items.map((item) => (
            <li key={item.id} className="flex items-center gap-3">
              <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                <Image src={item.imageUrl ?? "/images/placeholder.svg"} alt={item.productName} fill sizes="56px" className="object-cover" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                  {item.productSlug ? (
                    <Link href={`/product/${item.productSlug}`} className="hover:text-primary">
                      {item.productName}
                    </Link>
                  ) : (
                    item.productName
                  )}
                  {item.giftWrap && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                      🎁 Gift wrapped
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
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatPKR(order.subtotal)}</span>
          </div>
          {order.discountTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Discount {order.couponCode ? `(${order.couponCode})` : ""}</span>
              <span className="text-primary">− {formatPKR(order.discountTotal)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Delivery ({order.deliveryMethod === "EXPRESS" ? "Express" : "Standard"})</span>
            <span>{order.deliveryFee === 0 ? "FREE" : formatPKR(order.deliveryFee)}</span>
          </div>
          {order.giftWrapCharge > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Gift Wrapping</span>
              <span>{formatPKR(order.giftWrapCharge)}</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2.5 text-base">
            <span className="font-bold">Total</span>
            <span className="font-extrabold text-primary">{formatPKR(order.total)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Payment: {order.paymentMethod === "COD" ? "Cash on Delivery" : order.paymentMethod} · {order.paymentStatus}
          </p>
        </div>
      </div>

      {/* Address */}
      <div className="mt-4 rounded-xl border p-5">
        <h2 className="text-sm font-bold">Delivery Address</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          <span className="font-medium text-foreground">{order.shipFullName}</span> · {order.shipPhone}
          <br />
          {order.shipLine1}
          {order.shipLine2 ? `, ${order.shipLine2}` : ""}
          <br />
          {order.shipCity}, {order.shipProvince} {order.shipPostalCode ?? ""}
        </p>
      </div>

      <Button asChild variant="ghost" className="mt-6">
        <Link href="/account/orders">← Back to My Orders</Link>
      </Button>
    </div>
  );
}
