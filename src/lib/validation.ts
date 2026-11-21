// Zod validation schemas — shared by API routes and forms (FR-46, FR-49, NFR-13).
import { z } from "zod";

// NOTE: zod v4 is installed; API remains compatible for these schemas.

export const emailSchema = z.string().trim().toLowerCase().email("Please enter a valid email address");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password is too long");

export const pakPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, "")) // tolerate "0300 1234567", "+92-300-..."
  .pipe(
    z
      .string()
      .regex(/^(\+?92|0)?[0-9]{10}$/, "Please enter a valid phone number (e.g. 0300 1234567)")
      .transform((v) => {
        const digits = v.replace(/\D/g, "");
        if (digits.startsWith("92")) return `0${digits.slice(2)}`;
        if (digits.startsWith("0")) return digits;
        return `0${digits}`;
      })
  );

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Please enter your full name").max(80),
  email: emailSchema,
  password: passwordSchema,
  // Post-verification destination, carried in the outbox payload (Chunk
  // 7-final) so the verification link lands here instead of "/account".
  // Validated again at send time by safeCallbackUrl.
  callbackUrl: z.string().max(2048).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Please enter your password"),
});

export const profileSchema = z.object({
  name: z.string().trim().min(2, "Please enter your full name").max(80),
  phone: pakPhoneSchema.optional().or(z.literal("")),
  image: z.string().url().optional().or(z.literal("")),
});

// ─── Addresses ───
// The province list, defined once and shared by the checkout form, the
// addresses manager and server-side validation (Phase 3, chunk 12
// follow-up B): province was free text server-side, so a typo'd province
// could be saved and then fail silently downstream. Writes validate
// against this list; reads never reject legacy values — a saved address
// with an out-of-list province is still displayed and usable, it just
// cannot be re-saved without picking a listed province.
export const PROVINCES = [
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "Gilgit-Baltistan",
  "Azad Kashmir",
  "Islamabad Capital Territory",
] as const;

export const provinceSchema = z.enum(PROVINCES, {
  error: "Please select a province",
});

export const addressSchema = z.object({
  label: z.string().trim().min(1, "Label is required (e.g. Home)").max(30),
  fullName: z.string().trim().min(2, "Recipient name is required").max(80),
  phone: pakPhoneSchema,
  line1: z.string().trim().min(5, "Please enter the full street address").max(200),
  line2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().min(2, "City is required").max(60),
  province: provinceSchema,
  postalCode: z
    .string()
    .trim()
    .max(10)
    .regex(/^[0-9]{0,5}$/, "Postal code must be digits")
    .optional()
    .or(z.literal("")),
  isDefault: z.boolean().optional().default(false),
});

// ─── Checkout (FR-19, BR-02) ───
export const checkoutCustomerSchema = z.object({
  name: z.string().trim().min(2, "Please enter your full name").max(80),
  email: emailSchema,
  phone: pakPhoneSchema,
});

export const checkoutAddressSchema = z.object({
  fullName: z.string().trim().min(2, "Recipient name is required").max(80),
  phone: pakPhoneSchema,
  line1: z.string().trim().min(5, "Please enter the full street address").max(200),
  line2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().min(2, "City is required").max(60),
  province: provinceSchema,
  postalCode: z
    .string()
    .trim()
    .max(10)
    .regex(/^[0-9]{0,5}$/, "Postal code must be digits")
    .optional()
    .or(z.literal("")),
});

export const placeOrderSchema = z.object({
  idempotencyKey: z.string().min(16).max(80),
  customer: checkoutCustomerSchema,
  address: checkoutAddressSchema,
  deliveryMethod: z.enum(["STANDARD", "EXPRESS"]),
  paymentMethod: z.enum(["COD", "ONLINE"]),
  // gift wrap selection is PER CART ITEM — read from the DB cart, never trusted from the client
  giftWrapMessage: z.string().trim().max(200).optional().or(z.literal("")),
  couponCode: z.string().trim().max(40).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// ─── Admin: products ───
// Rating / reviewCount are NOT accepted here: they are calculated from
// APPROVED reviews only (src/services/reviews.service.ts) and must never
// be overwritten by an admin payload. The schema is strict, so a payload
// carrying rating/reviewCount (or any other unknown key) is rejected with
// 422 instead of being silently stripped.
export const productSchema = z
  .object({
    name: z.string().trim().min(3, "Product name is required").max(120),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]*$/, "Slug may contain lowercase letters, numbers and dashes")
      .max(140)
      .optional()
      .or(z.literal("")),
    description: z.string().trim().max(5000).default(""),
    brand: z.string().trim().max(60).optional().or(z.literal("")),
    sku: z.string().trim().max(60).optional().or(z.literal("")),
    categoryId: z.string().min(1, "Please choose a category"),
    price: z.coerce.number().int("Price must be a whole number").min(1, "Price must be greater than 0"),
    comparePrice: z.coerce.number().int().min(0).optional().nullable(),
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).default("DRAFT"),
    isFeatured: z.boolean().default(false),
    tags: z.string().trim().max(300).optional().or(z.literal("")),
    images: z.array(z.string().trim().min(1)).min(1, "Add at least one product image").max(8),
    stock: z.coerce.number().int().min(0).default(0),
    lowStockThreshold: z.coerce.number().int().min(0).default(5),
  })
  .strict();

// ─── Admin: categories ───
export const categorySchema = z.object({
  name: z.string().trim().min(2, "Category name is required").max(80),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]*$/, "Slug may contain lowercase letters, numbers and dashes")
    .max(90)
    .optional()
    .or(z.literal("")),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  imageUrl: z.string().trim().max(400).optional().or(z.literal("")),
  parentId: z.string().trim().max(40).optional().nullable(),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

// ─── Admin: inventory ───
export const inventoryUpdateSchema = z.object({
  productId: z.string().min(1),
  /** Null/absent = the product-level stock row; set = that variant's row.
   * Nullish (not just optional): the admin UI sends explicit `null` for
   * product-level rows, and the service treats null as product-level — the
   * old `.optional()` rejected that with a 422 on every product-level
   * stock update (E2E, Stream E). */
  variantId: z.string().min(1).nullish(),
  quantity: z.coerce
    .number()
    .int("Stock must be a whole number")
    .min(0, "Stock cannot be negative"),
  lowStockThreshold: z.coerce.number().int().min(0).max(999).optional(),
});

// ─── Admin: product variants (Phase 3, Chunk 8 — D12) ───
// Denormalised label-string model: label + SKU are required; priceOverride
// is ABSOLUTE (null = inherit the product price).
export const variantSchema = z.object({
  label: z.string().trim().min(1, "Variant label is required").max(120),
  sku: z.string().trim().min(1, "SKU is required").max(60),
  priceOverride: z.coerce.number().int("Price must be a whole number").min(1, "Price must be greater than 0").optional().nullable(),
  stock: z.coerce.number().int().min(0, "Stock cannot be negative").default(0),
  lowStockThreshold: z.coerce.number().int().min(0).max(999).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().default(true),
});

/** Update payload for a variant. Written out explicitly — NOT
 *  `variantSchema.partial()`: the create schema's `.default(0)` on stock
 *  and `.default(true)` on isActive would fire on an omitted key and a
 *  PATCH that only renames a variant would silently zero its stock. */
export const variantUpdateSchema = z.object({
  label: z.string().trim().min(1, "Label must not be empty").max(120, "Label must be 120 characters or fewer").optional(),
  sku: z.string().trim().min(1, "SKU must not be empty").max(120, "SKU must be 120 characters or fewer").optional(),
  priceOverride: z.number().int("Price override must be a whole number (Rs)").positive("Price override must be greater than 0").max(10_000_000).nullable().optional(),
  stock: z.number().int("Stock must be a whole number").min(0, "Stock cannot be negative").max(100_000).optional(),
  lowStockThreshold: z.number().int().min(1).max(999).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});

// ─── Customer: product reviews (Phase 3, Chunk 9 — D13) ───
// Rating is required (integer 1–5); text is optional. The same shape is
// used for create and update — an edit always resubmits both fields and
// returns the review to pending moderation.
export const reviewSchema = z.object({
  rating: z.coerce
    .number()
    .int("Rating must be a whole number")
    .min(1, "Rating must be between 1 and 5")
    .max(5, "Rating must be between 1 and 5"),
  text: z.string().trim().max(1000, "Review must be 1000 characters or fewer").optional().nullable(),
});

// ─── Admin: review moderation (Phase 3, Chunk 9 — D13) ───
export const reviewModerationSchema = z.object({
  action: z.enum(["APPROVED", "REJECTED"]),
});

// ─── Admin: coupons / promotions / banners ───
export const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{3,20}$/, "Use 3-20 letters/numbers, no spaces"),
    description: z.string().trim().max(200).optional().or(z.literal("")),
    type: z.enum(["PERCENT", "FIXED"]),
    value: z.coerce.number().int().min(1, "Value must be at least 1"),
    minOrderAmount: z.coerce.number().int().min(0).default(0),
    maxUses: z.coerce.number().int().min(1).optional().nullable(),
    // Max-discount cap (D11/M-21): null = no cap.
    maxDiscountAmount: z.coerce.number().int().min(1, "Max discount must be at least Rs 1").optional().nullable(),
    // First-order-only (D11): WELCOME10 is seeded with this on.
    firstOrderOnly: z.boolean().default(false),
    startsAt: z.string().optional().or(z.literal("")),
    expiresAt: z.string().optional().or(z.literal("")),
    isActive: z.boolean().default(true),
  })
  .refine((d) => d.type !== "PERCENT" || d.value <= 100, {
    message: "Percent discount cannot exceed 100",
    path: ["value"],
  })
  .refine((d) => !d.startsAt || !d.expiresAt || new Date(d.startsAt) < new Date(d.expiresAt), {
    message: "Start date must be before the expiry date",
    path: ["expiresAt"],
  });

export const promotionSchema = z
  .object({
    title: z.string().trim().min(2, "Title is required").max(120),
    description: z.string().trim().max(500).optional().or(z.literal("")),
    type: z.enum(["PERCENT", "FIXED"]),
    value: z.coerce.number().int().min(1, "Value must be at least 1"),
    minOrderAmount: z.coerce.number().int().min(0).optional().nullable(),
    startsAt: z.string().optional().or(z.literal("")),
    endsAt: z.string().optional().or(z.literal("")),
    isActive: z.boolean().default(true),
    // Optimistic-lock version the caller loaded (Chunk 11, Low); the admin
    // manager sends it, direct callers may omit it (see adminUpdatePromotion).
    version: z.coerce.number().int().min(0).optional(),
  })
  .refine((d) => d.type !== "PERCENT" || d.value <= 100, {
    message: "Percent discount cannot exceed 100",
    path: ["value"],
  })
  .refine((d) => !d.startsAt || !d.endsAt || new Date(d.startsAt) < new Date(d.endsAt), {
    message: "Start date must be before the end date",
    path: ["endsAt"],
  });

/** Root-relative path ("/...") or absolute http(s) URL; blocks protocol-relative and dangerous schemes. */
export function isSafeHttpReference(value: string): boolean {
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export const bannerSchema = z.object({
  title: z.string().trim().min(2, "Title is required").max(120),
  subtitle: z.string().trim().max(200).optional().or(z.literal("")),
  // Stored image reference: an uploaded/storage URL, an external http(s) image
  // URL, or a root-relative public path. javascript:, data:, blob: etc. rejected.
  imageUrl: z
    .string()
    .trim()
    .min(1, "Image is required")
    .max(600)
    .refine(isSafeHttpReference, "Use an uploaded image or an http(s) image URL"),
  // Destination link: same safety rules — never javascript:/data: destinations.
  linkUrl: z
    .string()
    .trim()
    .max(600)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || isSafeHttpReference(v), "Link must be a site path or an http(s) URL"),
  placement: z.enum(["HERO", "SIDE", "STRIP"]).default("HERO"),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

// ─── Admin: settings (store_settings key/value) ───
export const settingsSchema = z.object({
  store_name: z.string().trim().min(1).max(60),
  store_tagline: z.string().trim().max(120).optional().or(z.literal("")),
  store_email: emailSchema,
  store_phone: z.string().trim().max(20).optional().or(z.literal("")),
  store_address: z.string().trim().max(200).optional().or(z.literal("")),
  whatsapp_number: z
    .string()
    .trim()
    .regex(/^[0-9]{10,14}$/, "Use digits only with country code, e.g. 923001234567"),
  announcement_text: z.string().trim().max(120).optional().or(z.literal("")),
  cod_enabled: z.boolean().default(true),
  online_payment_enabled: z.boolean().default(false),
  delivery_fee_standard: z.coerce.number().int().min(0),
  delivery_fee_express: z.coerce.number().int().min(0),
  free_delivery_threshold: z.coerce.number().int().min(0),
  gift_wrap_enabled: z.boolean().default(true),
  gift_wrap_charge: z.coerce.number().int().min(0),
  gift_wrap_description: z.string().trim().max(200).optional().or(z.literal("")),
  facebook_url: z.string().trim().max(200).optional().or(z.literal("")),
  instagram_url: z.string().trim().max(200).optional().or(z.literal("")),
});

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type ProductFormInput = z.infer<typeof productSchema>;
export type CategoryFormInput = z.infer<typeof categorySchema>;
export type CouponFormInput = z.infer<typeof couponSchema>;
export type PromotionFormInput = z.infer<typeof promotionSchema>;
export type SettingsFormInput = z.infer<typeof settingsSchema>;

/** Flatten a ZodError into { field: message } for form display (FR-49). */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
