// Regression test: saved-address checkout validation.
//
// Bug: at Confirm Order, `placeOrder` validated the selected address with a
// check that required a valid email ON the address object. Saved addresses
// never carry an email — the Address model has no email column, and the
// checkout page maps DB rows without one — so every saved address failed
// validation and the customer was bounced to the Address step with
// "Please complete your delivery details first.", even though the Review page
// (which renders only address fields) looked complete. The contact email
// belongs to the CUSTOMER (checkoutCustomerSchema): the signed-in user's
// session email, or the email a guest typed into the new-address form.
// The fix validates address fields and the customer email separately
// (src/lib/checkout-validation.ts), sourced from the right place.
import { describe, expect, it } from "vitest";
import {
  addressFieldErrors,
  deliveryDetailsComplete,
  isValidCustomerEmail,
} from "@/lib/checkout-validation";
import { placeOrderSchema } from "@/lib/validation";

// Exactly what src/app/(store)/checkout/page.tsx produces from a DB row:
// id, label, fullName, phone, line1, line2, city, province, postalCode,
// isDefault — and NO `email` (the Address model has no email column).
const savedDefaultAddress = {
  id: "addr_default_1",
  label: "Home",
  fullName: "Adeel Khan",
  phone: "03001234567",
  line1: "123 Main Street, Gulberg",
  line2: null,
  city: "Lahore",
  province: "Punjab",
  postalCode: "54000",
  isDefault: true,
};

// Exactly what createAddress returns for a newly saved address in the same
// session (the Prisma row — also no email).
const newlySavedAddress = {
  id: "addr_new_1",
  userId: "user_1",
  label: "Office",
  fullName: "Adeel Khan",
  phone: "03001234567",
  line1: "45 Business Road, Blue Area",
  line2: null,
  city: "Islamabad",
  province: "Islamabad Capital Territory",
  postalCode: "44000",
  isDefault: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const signedInUserEmail = "adeel@example.com";

// The payload placeOrder() builds for ONLINE payment (Safepay Sandbox),
// with the customer email from the session and the address fields from the
// selected saved address.
function onlinePayload(address: typeof savedDefaultAddress, customerEmail: string) {
  return {
    idempotencyKey: "chk-regression-000000001",
    customer: { name: "Adeel Khan", email: customerEmail, phone: address.phone },
    address: {
      fullName: address.fullName,
      phone: address.phone,
      line1: address.line1,
      line2: address.line2 ?? "",
      city: address.city,
      province: address.province,
      postalCode: address.postalCode ?? "",
    },
    deliveryMethod: "STANDARD",
    paymentMethod: "ONLINE",
    giftWrapMessage: "",
    couponCode: "",
  };
}

describe("saved-address checkout validation (regression)", () => {
  it("accepts a selected default saved address (no email field) with a signed-in user email", () => {
    // The exact reported scenario: saved default address + Online Payment.
    expect(deliveryDetailsComplete(savedDefaultAddress, signedInUserEmail)).toBe(true);
    expect(addressFieldErrors(savedDefaultAddress)).toEqual({});
  });

  it("accepts a newly saved address (Prisma row, no email) with a signed-in user email", () => {
    // A signed-in user who enters a new address gets it saved, then selected;
    // the returned row has no email either, so it hit the same bug.
    expect(deliveryDetailsComplete(newlySavedAddress, signedInUserEmail)).toBe(true);
  });

  it("lets the ONLINE place-order payload through: backend schema accepts it", () => {
    const parsed = placeOrderSchema.safeParse(onlinePayload(savedDefaultAddress, signedInUserEmail));
    expect(parsed.success).toBe(true);
  });

  it("still rejects when the customer email is missing", () => {
    expect(deliveryDetailsComplete(savedDefaultAddress, "")).toBe(false);
    expect(deliveryDetailsComplete(savedDefaultAddress, undefined)).toBe(false);
    expect(deliveryDetailsComplete(savedDefaultAddress, null)).toBe(false);
  });

  it("still rejects when the customer email is invalid", () => {
    expect(isValidCustomerEmail("not-an-email")).toBe(false);
    expect(isValidCustomerEmail("adeel@")).toBe(false);
    expect(deliveryDetailsComplete(savedDefaultAddress, "not-an-email")).toBe(false);
  });

  it("still rejects a saved address with invalid address fields", () => {
    expect(deliveryDetailsComplete({ ...savedDefaultAddress, phone: "123" }, signedInUserEmail)).toBe(false);
    expect(addressFieldErrors({ ...savedDefaultAddress, phone: "123" })).toMatchObject({
      phone: expect.any(String),
    });
    expect(deliveryDetailsComplete({ ...savedDefaultAddress, line1: "Abc" }, signedInUserEmail)).toBe(false);
    expect(deliveryDetailsComplete({ ...savedDefaultAddress, city: "L" }, signedInUserEmail)).toBe(false);
    expect(deliveryDetailsComplete({ ...savedDefaultAddress, fullName: "A" }, signedInUserEmail)).toBe(false);
  });

  it("flags province and postalCode too (chunk 12 follow-up B: both were omitted)", () => {
    expect(addressFieldErrors({ ...savedDefaultAddress, province: "Nowhere" })).toMatchObject({
      province: expect.any(String),
    });
    expect(deliveryDetailsComplete({ ...savedDefaultAddress, province: "Nowhere" }, signedInUserEmail)).toBe(false);
    expect(addressFieldErrors({ ...savedDefaultAddress, postalCode: "ABC" })).toMatchObject({
      postalCode: expect.any(String),
    });
    expect(deliveryDetailsComplete({ ...savedDefaultAddress, postalCode: "ABC" }, signedInUserEmail)).toBe(false);
    // In-list province and a digits-only postal code pass.
    expect(addressFieldErrors(savedDefaultAddress)).toEqual({});
    expect(addressFieldErrors({ ...savedDefaultAddress, province: "Sindh", postalCode: "75000" })).toEqual({});
  });

  it("still rejects a null address", () => {
    expect(deliveryDetailsComplete(null, signedInUserEmail)).toBe(false);
    expect(deliveryDetailsComplete(undefined, signedInUserEmail)).toBe(false);
  });

  it("accepts a guest new-address form with a valid typed email", () => {
    const guestForm = { ...savedDefaultAddress, email: "guest@example.com" };
    expect(deliveryDetailsComplete(guestForm, guestForm.email)).toBe(true);
  });

  it("rejects a guest new-address form with an invalid or missing typed email", () => {
    const guestForm = { ...savedDefaultAddress, email: "bad-email" };
    expect(deliveryDetailsComplete(guestForm, guestForm.email)).toBe(false);
    expect(deliveryDetailsComplete({ ...savedDefaultAddress, email: "" }, "")).toBe(false);
  });
});
