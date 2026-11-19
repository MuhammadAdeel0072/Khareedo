// Pure checkout delivery-details validation (FR-19, BR-02).
//
// The delivery ADDRESS carries no email: the Address model has no email
// column, `checkoutAddressSchema` has no email field, and the checkout page
// maps saved DB rows without one. The contact email belongs to the CUSTOMER
// (`checkoutCustomerSchema`) — the signed-in user's session email, or the
// email a guest typed into the new-address form. Requiring an email on the
// address object made every saved address fail validation at Confirm Order,
// bouncing the customer back to the Address step even though the Review page
// (which renders only address fields) looked complete. These helpers keep the
// two concerns separate so the address check and the customer-email check can
// each be sourced from the right place.
export interface CheckoutAddressInput {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  province: string;
  postalCode?: string | null;
  // Present on the new-address form (a guest's typed email), absent on saved
  // addresses. Ignored here — the email is validated separately as the
  // customer email, never as part of the address.
  email?: string;
}

// Address fields only — mirrors `checkoutAddressSchema` (no email).
export function addressFieldErrors(a: CheckoutAddressInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (a.fullName.trim().length < 2) errors.fullName = "Recipient name is required";
  if (!/^(\+?92|0)?\d{10}$/.test(a.phone.replace(/[\s-]/g, "")))
    errors.phone = "Enter a valid phone (e.g. 0300 1234567)";
  if (a.line1.trim().length < 5) errors.line1 = "Please enter the full street address";
  if (a.city.trim().length < 2) errors.city = "City is required";
  return errors;
}

export function isValidCustomerEmail(email: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? "");
}

// Delivery details are complete when the address fields are valid AND the
// customer email (session email for signed-in customers, typed email for
// guests) is a valid email address.
export function deliveryDetailsComplete(
  address: CheckoutAddressInput | null | undefined,
  customerEmail: string | null | undefined
): boolean {
  if (!address) return false;
  return (
    Object.keys(addressFieldErrors(address)).length === 0 &&
    isValidCustomerEmail(customerEmail)
  );
}
