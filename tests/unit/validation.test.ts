// Unit tests — validation schemas (FR-49, BR-02), order reference (FR-24), WhatsApp (FR-35/BR-13).
import { describe, expect, it } from "vitest";
import {
  registerSchema,
  checkoutAddressSchema,
  placeOrderSchema,
  couponSchema,
  pakPhoneSchema,
} from "@/lib/validation";
import { generateOrderReference, formatPKR } from "@/lib/utils";
import { buildCartInquiryMessage, buildProductInquiryMessage } from "@/lib/whatsapp-messages";

describe("phone normalization (FR-19)", () => {
  it("normalizes Pakistani formats to 03XXXXXXXXX", () => {
    expect(pakPhoneSchema.parse("0300 1234567")).toBe("03001234567");
    expect(pakPhoneSchema.parse("+923001234567")).toBe("03001234567");
    expect(pakPhoneSchema.parse("923001234567")).toBe("03001234567");
    expect(pakPhoneSchema.parse("3001234567")).toBe("03001234567");
  });

  it("rejects invalid numbers", () => {
    expect(pakPhoneSchema.safeParse("12345").success).toBe(false);
    expect(pakPhoneSchema.safeParse("abc").success).toBe(false);
  });
});

describe("register schema (FR-02)", () => {
  it("accepts valid registration", () => {
    const r = registerSchema.safeParse({ name: "Ali Hassan", email: "ALI@Example.com", password: "secret123" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("ali@example.com"); // normalized
  });

  it("rejects short passwords and bad emails", () => {
    expect(registerSchema.safeParse({ name: "Ali", email: "a@b.c", password: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ name: "Ali", email: "not-an-email", password: "secret123" }).success).toBe(false);
  });
});

describe("checkout address schema (BR-02)", () => {
  it("requires complete delivery details", () => {
    const ok = checkoutAddressSchema.safeParse({
      fullName: "Ali Hassan",
      phone: "03001234567",
      line1: "House 12, Street 5, Gulberg",
      city: "Lahore",
      province: "Punjab",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects incomplete address", () => {
    const bad = checkoutAddressSchema.safeParse({ fullName: "A", phone: "1", line1: "x", city: "", province: "" });
    expect(bad.success).toBe(false);
  });
});

describe("place order schema (FR-27 idempotency)", () => {
  const base = {
    customer: { name: "Ali Hassan", email: "ali@example.com", phone: "03001234567" },
    address: {
      fullName: "Ali Hassan",
      phone: "03001234567",
      line1: "House 12, Street 5, Gulberg",
      city: "Lahore",
      province: "Punjab",
    },
    deliveryMethod: "STANDARD",
    paymentMethod: "COD",
  };

  it("requires a long idempotency key", () => {
    expect(placeOrderSchema.safeParse({ ...base, idempotencyKey: "short" }).success).toBe(false);
    expect(placeOrderSchema.safeParse({ ...base, idempotencyKey: "chk-abc123def456789" }).success).toBe(true);
  });

  it("rejects unknown payment methods", () => {
    expect(
      placeOrderSchema.safeParse({ ...base, idempotencyKey: "chk-abc123def456789", paymentMethod: "BITCOIN" }).success
    ).toBe(false);
  });
});

describe("coupon schema (D-06)", () => {
  it("accepts a valid coupon", () => {
    const r = couponSchema.safeParse({ code: "welcome10", type: "PERCENT", value: 10, minOrderAmount: 2000, isActive: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("WELCOME10"); // uppercased
  });

  it("rejects percent > 100 and bad codes", () => {
    expect(couponSchema.safeParse({ code: "BIG", type: "PERCENT", value: 150, isActive: true }).success).toBe(false);
    expect(couponSchema.safeParse({ code: "X", type: "FIXED", value: 10, isActive: true }).success).toBe(false);
    expect(couponSchema.safeParse({ code: "HAS SPACE", type: "FIXED", value: 10, isActive: true }).success).toBe(false);
  });
});

describe("order reference generation (FR-24)", () => {
  it("produces KH-prefixed unique references", () => {
    const a = generateOrderReference();
    const b = generateOrderReference();
    expect(a).toMatch(/^KH\d{13}$/); // KH + yymmdd + 7-digit random
    expect(a).not.toBe(b);
  });
});

describe("money formatting (D-07)", () => {
  it("formats PKR like the mockups", () => {
    expect(formatPKR(5699)).toBe("Rs 5,699");
    expect(formatPKR(1265430)).toBe("Rs 1,265,430");
    expect(formatPKR(-5)).toBe("Rs 0");
  });
});

describe("WhatsApp message builders (FR-35, BR-13)", () => {
  it("product inquiry mentions the product and labels itself an inquiry", () => {
    const msg = buildProductInquiryMessage("Khareedo", "Casio Watch", 8999);
    expect(msg).toContain("Casio Watch");
    expect(msg).toContain("Rs 8,999");
    expect(msg.toLowerCase()).toContain("inquiry");
    expect(msg.toLowerCase()).toContain("not an order");
  });

  it("cart inquiry lists items and clarifies checkout-only confirmation", () => {
    const msg = buildCartInquiryMessage(
      "Khareedo",
      [
        { name: "Earbuds", quantity: 1 },
        { name: "Watch", quantity: 2 },
      ],
      12345
    );
    expect(msg).toContain("• Earbuds");
    expect(msg).toContain("• Watch × 2");
    expect(msg).toContain("Rs 12,345");
    expect(msg).toContain("website checkout");
  });
});
