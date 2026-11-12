// Admin order detail page (FR-41).
import { notFound } from "next/navigation";
import { adminGetOrderById } from "@/services/orders.service";
import { adminGetPaymentDiagnostics } from "@/services/admin-payment-diagnostics.service";
import { AdminOrderView, type AdminOrderDetail } from "@/components/admin/admin-order-view";
import { AdminPaymentDiagnosticsPanel } from "@/components/admin/admin-payment-diagnostics";

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
    userEmail: order.user?.email ?? null,
    items: order.items.map((i) => ({
      id: i.id,
      productName: i.productName,
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
        </div>
      )}
    </div>
  );
}
