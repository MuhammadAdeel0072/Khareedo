// Server-only session/cart-key helpers (FR-17).
// Pure WhatsApp message builders live in lib/whatsapp-messages.ts (client-safe).
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

export const GUEST_CART_COOKIE = "khareedo_cart";

export function newGuestCartKey(): string {
  return randomBytes(16).toString("hex");
}
