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

export const addressSchema = z.object({
  label: z.string().trim().min(1, "Label is required (e.g. Home)").max(30),
  fullName: z.string().trim().min(2, "Recipient name is required").max(80),
  phone: pakPhoneSchema,
  line1: z.string().trim().min(5, "Please enter the full street address").max(200),
  line2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().min(2, "City is required").max(60),
  province: z.string().trim().min(2, "Province is required").max(60),
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
  province: z.string().trim().min(2, "Province is required").max(60),
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
  paymentMethod: z.enum(["COD", "BANK_TRANSFER", "ONLINE"]),
  // gift wrap selection is PER CART ITEM — read from the DB cart, never trusted from the client
  giftWrapMessage: z.string().trim().max(200).optional().or(z.literal("")),
  couponCode: z.string().trim().max(40).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// ─── Admin: products ───
export const productSchema = z.object({
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
  rating: z.coerce.number().min(0).max(5).default(0),
  reviewCount: z.coerce.number().int().min(0).default(0),
  tags: z.string().trim().max(300).optional().or(z.literal("")),
  images: z.array(z.string().trim().min(1)).min(1, "Add at least one product image").max(8),
  stock: z.coerce.number().int().min(0).default(0),
  lowStockThreshold: z.coerce.number().int().min(0).default(5),
});

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
  quantity: z.coerce
    .number()
    .int("Stock must be a whole number")
    .min(0, "Stock cannot be negative"),
  lowStockThreshold: z.coerce.number().int().min(0).max(999).optional(),
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
    startsAt: z.string().optional().or(z.literal("")),
    expiresAt: z.string().optional().or(z.literal("")),
    isActive: z.boolean().default(true),
  })
  .refine((d) => d.type !== "PERCENT" || d.value <= 100, {
    message: "Percent discount cannot exceed 100",
    path: ["value"],
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
  })
  .refine((d) => d.type !== "PERCENT" || d.value <= 100, {
    message: "Percent discount cannot exceed 100",
    path: ["value"],
  });

export const bannerSchema = z.object({
  title: z.string().trim().min(2, "Title is required").max(120),
  subtitle: z.string().trim().max(200).optional().or(z.literal("")),
  imageUrl: z.string().trim().min(1, "Image is required").max(400),
  linkUrl: z.string().trim().max(400).optional().or(z.literal("")),
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
  bank_transfer_enabled: z.boolean().default(false),
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
