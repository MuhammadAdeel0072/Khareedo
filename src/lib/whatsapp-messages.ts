// WhatsApp message builders — PURE, client-safe (FR-35, BR-13).
// (Server-only cookie helpers live in lib/whatsapp.ts)
import { formatPKR } from "@/lib/utils";

export interface WhatsAppProductRef {
  name: string;
  quantity?: number;
}

export function buildWhatsAppUrl(number: string, message: string): string {
  const digits = number.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/** Generic assistance message (FR-34). */
export function buildInquiryMessage(storeName: string): string {
  return `Hello ${storeName}! I need some assistance with my shopping.`;
}

/** Product-specific inquiry (FR-35). Clearly an inquiry — never an order (BR-13). */
export function buildProductInquiryMessage(
  storeName: string,
  productName: string,
  price?: number
): string {
  const priceLine = price ? ` (Price: ${formatPKR(price)})` : "";
  return (
    `Hello ${storeName}! I'm interested in this product:\n\n` +
    `🛍 ${productName}${priceLine}\n\n` +
    `Could you please share more details? (This is an inquiry, not an order.)`
  );
}

/** Cart-assisted order inquiry (FR-35). Distinct from website checkout (BR-13). */
export function buildCartInquiryMessage(
  storeName: string,
  items: WhatsAppProductRef[],
  subtotal?: number
): string {
  const lines = items
    .map((i) => `• ${i.name}${i.quantity && i.quantity > 1 ? ` × ${i.quantity}` : ""}`)
    .join("\n");
  const total = subtotal ? `\n\nSubtotal: ${formatPKR(subtotal)}` : "";
  return (
    `Hello ${storeName}! I would like help placing an order for:\n\n${lines}${total}\n\n` +
    `Please assist me. (Note: this WhatsApp message is an inquiry — my order is only confirmed through website checkout.)`
  );
}
