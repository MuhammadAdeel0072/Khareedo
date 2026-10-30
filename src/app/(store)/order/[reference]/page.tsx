// Order confirmation + tracking (FR-25). Only shows success for real orders.
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CheckCircle2, MapPin, Package, CreditCard, MessageCircle } from "lucide-react";
import { getOrderByReference } from "@/services/orders.service";
import { getSessionUser } from "@/lib/auth-guard";
import { formatPKR, formatDateTime } from "@/lib/utils";
import { STATUS_BADGE_CLASSES } from "@/lib/constants";
import { WhatsAppIcon } from "@/components/layout/whatsapp-icon";
import { getSettings } from "@/services/settings.service";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Order Confirmation" };
export const dynamic = "force-dynamic";

export default async function OrderPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;
  const user = await getSessionUser();
  const order = await getOrderByReference(reference, user?.id);
  if (!order) notFound();
  const settings = await getSettings();

  const isConfirmed = order.status !== "CANCELLED";

  return (
    <div className="container-khd max-w-3xl py-10">
      {/* Confirmation banner */}
      <div className="flex flex-col items-center text-center">
        <span
          className={`flex h-16 w-16 items-center justify-center rounded-full ${
            isConfirmed ? "bg-brand-50 text-primary" : "bg-red-50 text-destructive"
          }`}
        >
          {isConfirmed ? (
            <CheckCircle2 className="h-9 w-9" aria-hidden="true" />
          ) : (
            <MessageCircle className="h-9 w-9" aria-hidden="true" />
          )}
        </span>
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight sm:text-3xl">
          {isConfirmed ? "Order Confirmed!" : "Order Cancelled"}
        </h1>
        <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
          {isConfirmed
            ? `Thank you, ${order.customerName.split(" ")[0]}! Your order has been placed successfully. We'll contact you at ${order.customerPhone} to arrange delivery.`
            : "This order was cancelled. If you have questions, please contact us on WhatsApp."}
        </p>
      </div>

      {/* Order meta */}
      <div className="mt-8 rounded-xl border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Order Reference</p>
            <p className="mt-0.5 font-mono text-lg font-bold">{order.reference}</p>
            <p className="mt-1 text-xs text-muted-foreground">Placed {formatDateTime(order.createdAt)}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge className={STATUS_BADGE_CLASSES[order.status] ?? ""} variant="outline">
              {order.status}
            </Badge>
            <Badge className={STATUS_BADGE_CLASSES[order.paymentStatus] ?? ""} variant="outline">
              Payment: {order.paymentStatus}
            </Badge>
          </div>
        </div>
      </div>

      {/* Items */}
      <div className="mt-4 rounded-xl border p-5">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Package className="h-4.5 w-4.5 text-primary" aria-hidden="true" /> Items ({order.items.length})
        </h2>
        <ul className="mt-4 space-y-3">
          {order.items.map((item) => (
            <li key={item.id} className="flex items-center gap-3">
              <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                <Image
                  src={item.imageUrl ?? "/images/placeholder.svg"}
                  alt={item.productName}
                  fill
                  sizes="56px"
                  className="object-cover"
                />
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
              <span className="text-muted-foreground">
                Discount {order.couponCode ? `(${order.couponCode})` : ""}
              </span>
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
            <span className="font-bold">Total ({order.paymentMethod === "COD" ? "Cash on Delivery" : order.paymentMethod})</span>
            <span className="font-extrabold text-primary">{formatPKR(order.total)}</span>
          </div>
        </div>
      </div>

      {/* Delivery info */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <MapPin className="h-4 w-4 text-primary" aria-hidden="true" /> Delivery Address
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            <span className="font-medium text-foreground">{order.shipFullName}</span>
            <br />
            {order.shipLine1}
            {order.shipLine2 ? `, ${order.shipLine2}` : ""}
            <br />
            {order.shipCity}, {order.shipProvince} {order.shipPostalCode ?? ""}
            <br />
            {order.shipPhone}
          </p>
        </div>
        <div className="rounded-xl border p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <CreditCard className="h-4 w-4 text-primary" aria-hidden="true" /> Payment
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {order.paymentMethod === "COD"
              ? "Cash on Delivery — please keep the exact amount ready."
              : order.paymentMethod === "BANK_TRANSFER"
                ? "Bank Transfer — our team will share account details."
                : "Online Payment"}
            {order.giftWrapSelected && (
              <>
                <br />
                <span className="font-medium text-foreground">
                  🎁 Gift wrapped ({order.items.filter((i) => i.giftWrap).length} of {order.items.length} item
                  {order.items.length === 1 ? "" : "s"})
                </span>
                {order.giftWrapMessage ? ` — note: "${order.giftWrapMessage}"` : ""}
              </>
            )}
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href="/products">Continue Shopping</Link>
        </Button>
        {user && (
          <Button asChild className="w-full sm:w-auto">
            <Link href="/account/orders">View My Orders</Link>
          </Button>
        )}
        <a
          href={`https://wa.me/${settings.whatsapp_number.replace(/\D/g, "")}?text=${encodeURIComponent(
            `Hello ${settings.store_name}! I have a question about my order ${order.reference}.`
          )}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[#25D366]/40 px-4 text-sm font-medium text-[#128C4B] transition hover:bg-[#25D366]/10 sm:w-auto"
        >
          <WhatsAppIcon className="h-4 w-4" />
          Ask about this order
        </a>
      </div>
    </div>
  );
}
