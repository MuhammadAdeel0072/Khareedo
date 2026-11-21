// Admin order detail page (FR-41).
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { adminGetOrderById } from "@/services/orders.service";
import { adminGetPaymentDiagnostics } from "@/services/admin-payment-diagnostics.service";
import {
  createPaymentRefundService,
  REFUND_SERVICE_OPTIONS,
} from "@/services/payment-refund.service";
import { AdminOrderView, type AdminOrderDetail } from "@/components/admin/admin-order-view";
import { AdminPaymentDiagnosticsPanel } from "@/components/admin/admin-payment-diagnostics";
import {
  AdminOrderRefundsPanel,
  type AdminRefundRow,
} from "@/components/admin/admin-order-refunds";

export const dynamic = "force-dynamic";
export const metadata = { title: "Order Details · Admin" };

export default async function AdminOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const order = await adminGetOrderById(id);
  if (!order) notFound();
  // Read-only Safepay diagnostics; null for legacy/COD orders (no managed payment flow).
  const diagnostics = await adminGetPaymentDiagnostics(id);
  // Read-only refund ledger for this order: no provider is injected, so
  // submissions are structurally impossible from this read path.
  const refundService = createPaymentRefundService(db as never, null, {
    environment: "sandbox",
    merchantAccountRef: "read-only",
    ...REFUND_SERVICE_OPTIONS,
  });
  const refundRows = await refundService.listRefunds({ orderId: id }, 50);
  const refunds: AdminRefundRow[] = refundRows.map((r) => ({
    id: r.id,
    paymentId: r.paymentId,
    amountMinor: r.amountMinor.toString(),
    currency: r.currency,
    type: r.type,
    status: r.status,
    providerReference: r.providerReference,
    providerState: r.providerState,
    failureMessage: r.failureMessage,
    reviewReason: r.reviewReason,
    requestedAt: r.requestedAt.toISOString(),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
  }));
  const paidPayment = diagnostics?.payments.find(
    (p) => p.status === "PAID" && p.paidVerifiedAt !== null
  );
  const refundablePayment = paidPayment
    ? {
        id: paidPayment.id,
        capturedAmountMinor: paidPayment.capturedAmountMinor ?? "0",
        refundedAmountMinor: paidPayment.refundedAmountMinor ?? "0",
        paidVerifiedAt: paidPayment.paidVerifiedAt,
      }
    : null;

  const detail: AdminOrderDetail = {
    id: order.id,
    reference: order.reference,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    isGuest: order.isGuest,
    shipFullName: order.shipFullName,
    shipPhone: order.shipPhone,
    shipLine1: order.shipLine1,
    shipLine2: order.shipLine2,
    shipCity: order.shipCity,
    shipProvince: order.shipProvince,
    shipPostalCode: order.shipPostalCode,
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    deliveryFee: order.deliveryFee,
    deliveryMethod: order.deliveryMethod,
    giftWrapCharge: order.giftWrapCharge,
    giftWrapSelected: order.giftWrapSelected,
    giftWrapMessage: order.giftWrapMessage,
    couponCode: order.couponCode,
    total: order.total,
    notes: order.notes,
    createdAt: order.createdAt.toISOString(),
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    statusHistory: order.statusHistory.map((h) => ({
      id: h.id,
      status: h.status,
      actor: h.actor,
      note: h.note,
      createdAt: h.createdAt.toISOString(),
    })),
    userEmail: order.user?.email ?? null,
    payments: order.payments.map((p) => ({
      id: p.id,
      provider: p.provider,
      amount: p.amount,
      status: p.status,
      reference: p.reference,
      createdAt: p.createdAt.toISOString(),
    })),
    items: order.items.map((i) => ({
      id: i.id,
      productName: i.productName,
      variantLabel: i.variantLabel,
      productSlug: i.productSlug,
      imageUrl: i.imageUrl,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
      giftWrap: i.giftWrap,
    })),
  };

  return (
    <div className="p-4 sm:p-6">
      <AdminOrderView order={detail} />
      {diagnostics && (
        <div className="mx-auto max-w-4xl">
          <AdminPaymentDiagnosticsPanel data={diagnostics} />
          <AdminOrderRefundsPanel payment={refundablePayment} refunds={refunds} />
        </div>
      )}
    </div>
  );
}
