// Cart type shared between server and client components.
export interface CartItemDetail {
  itemId: string;
  productId: string;
  name: string;
  slug: string;
  price: number;
  comparePrice: number | null;
  image: string | null;
  quantity: number;
  stock: number;
  lowStock: boolean;
  outOfStock: boolean;
  lineTotal: number;
  priceChanged: boolean;
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
}
