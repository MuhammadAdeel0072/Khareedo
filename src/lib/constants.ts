// Khareedo shared constants — single source of truth for statuses & enums.

export const SITE_NAME = "Khareedo";
export const SITE_TAGLINE = "Everyday essentials. Better choices.";

export const PRODUCTS_PER_PAGE = 12;
export const ADMIN_PAGE_SIZE = 15;

// Order status state machine (docs/REQUIREMENTS-TRACEABILITY.md §6)
export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Which transitions an administrator may perform (FR-41, BR-11)
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

// Statuses that are eligible for stock restoration on cancel (BR-11)
export const STOCK_RESTORING_STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
];

export const PAYMENT_METHODS = ["COD", "ONLINE"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["PENDING", "PAID", "FAILED", "REFUNDED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DELIVERY_METHODS = ["STANDARD", "EXPRESS"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const PRODUCT_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_SORTS = [
  "featured",
  "newest",
  "price-asc",
  "price-desc",
  "rating",
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const COUPON_TYPES = ["PERCENT", "FIXED"] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const BANNER_PLACEMENTS = ["HERO", "SIDE", "STRIP"] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

// Order/status badges use four semantic tones only: warning (awaiting action),
// brand tint (in progress), solid brand (completed), destructive (failed /
// cancelled) and muted (terminal-neutral). No per-status rainbow hues.
export const STATUS_BADGE_CLASSES: Record<string, string> = {
  PENDING: "bg-warning/10 text-warning-dark border-warning/30",
  CONFIRMED: "bg-brand-50 text-primary border-primary/20",
  PROCESSING: "bg-brand-50 text-primary border-primary/20",
  SHIPPED: "bg-brand-50 text-primary border-primary/20",
  DELIVERED: "bg-primary text-primary-foreground border-transparent",
  CANCELLED: "bg-destructive/10 text-destructive border-destructive/30",
  PAID: "bg-primary text-primary-foreground border-transparent",
  FAILED: "bg-destructive/10 text-destructive border-destructive/30",
  REFUNDED: "bg-muted text-muted-foreground border-border",
  DRAFT: "bg-muted text-muted-foreground border-border",
  PUBLISHED: "bg-primary text-primary-foreground border-transparent",
  ARCHIVED: "bg-muted text-muted-foreground border-border",
};
