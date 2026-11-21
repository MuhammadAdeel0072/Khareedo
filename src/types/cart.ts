// Cart type shared between server and client components.
export interface CartItemDetail {
  itemId: string;
  productId: string;
  /** Null = the product itself (no variant). */
  variantId: string | null;
  variantLabel: string | null;
  name: string;
  slug: string;
  /** Effective unit price: the variant's absolute override when set, else
   *  the product price (Chunk 8 — D12). */
  price: number;
  comparePrice: number | null;
  image: string | null;
  /**
   * Effective (live-stock-clamped) quantity — what the customer can actually
   * buy. The stored CartItem quantity may be higher when stock dropped after
   * the item was added; display and totals always use this value so the cart
   * subtotal equals the checkout quote subtotal. placeOrder re-reads the
   * stored quantity inside its transaction and rejects overstock by name.
   */
  quantity: number;
  stock: number;
  lowStock: boolean;
  outOfStock: boolean;
  lineTotal: number;
  /** Per-line gift wrap flag — the system knows EXACTLY which product(s) to wrap. */
  giftWrap: boolean;
}

export interface CartDetails {
  id: string;
  items: CartItemDetail[];
  itemCount: number;
  subtotal: number;
  /** Total purchasable units flagged for gift wrapping (drives the per-unit wrap charge). */
  wrappedUnits: number;
  /**
   * Lines removed from the stored cart on this load — deleted, inactive or
   * out-of-stock products (Phase 3, M-13). The UI surfaces them so the
   * removal is never silent; the rows are already deleted by the time this
   * is returned.
   */
  removed: { productId: string; name: string }[];
}

/** Why a guest-cart line was not merged into the signed-in cart (Phase 3, H-7). */
export type GuestCartSkipReason = "unavailable" | "out_of_stock" | "already_in_cart";

export interface GuestCartMergeSummary {
  merged: { productId: string; name: string; quantity: number }[];
  skipped: { productId: string; name: string; reason: GuestCartSkipReason }[];
  /**
   * Whether the guest-cart cookie was actually cleared. Next.js forbids
   * cookie mutation during page render, so a merge triggered from a page
   * directly (the checkout page still calls mergeGuestCart itself) reports
   * false here — the guest cart row is still deleted, so the stale cookie
   * is harmless and self-healing (a later guest cart is created under the
   * same key). Merges triggered through the Server Action
   * (src/actions/cart.ts — cart page, post-login landing) run with a
   * mutable cookie store, so the cookie IS cleared and this is true.
   */
  cookieCleared: boolean;
}
