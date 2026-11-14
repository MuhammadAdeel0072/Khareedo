// Unit tests — payment-method selection rules (FR-19/20, checkout payment fix).
import { describe, expect, it } from "vitest";
import {
  availablePaymentMethods,
  defaultPaymentMethod,
  isEligiblePaymentMethod,
  type PaymentEligibility,
} from "@/lib/payment-defaults";

const ALL_ON: PaymentEligibility = {
  codEnabled: true,
  bankTransferEnabled: true,
  sandboxPaymentEnabled: true,
};

describe("availablePaymentMethods — eligibility in preference order", () => {
  it("returns all methods in COD-first preference order when everything is enabled", () => {
    expect(availablePaymentMethods(ALL_ON)).toEqual(["COD", "BANK_TRANSFER", "ONLINE"]);
  });

  it("excludes COD when disabled", () => {
    expect(availablePaymentMethods({ ...ALL_ON, codEnabled: false })).toEqual([
      "BANK_TRANSFER",
      "ONLINE",
    ]);
  });

  it("excludes sandbox online payment when disabled (production default)", () => {
    expect(availablePaymentMethods({ ...ALL_ON, sandboxPaymentEnabled: false })).toEqual([
      "COD",
      "BANK_TRANSFER",
    ]);
  });

  it("returns an empty list when nothing is eligible", () => {
    expect(
      availablePaymentMethods({ codEnabled: false, bankTransferEnabled: false, sandboxPaymentEnabled: false })
    ).toEqual([]);
  });
});

describe("defaultPaymentMethod — first eligible method preselected", () => {
  it("prefers COD when enabled", () => {
    expect(defaultPaymentMethod(ALL_ON)).toBe("COD");
  });

  it("falls back to bank transfer when COD is disabled", () => {
    expect(defaultPaymentMethod({ ...ALL_ON, codEnabled: false })).toBe("BANK_TRANSFER");
  });

  it("returns null when nothing is eligible — UI must block, not guess", () => {
    expect(
      defaultPaymentMethod({ codEnabled: false, bankTransferEnabled: false, sandboxPaymentEnabled: false })
    ).toBeNull();
  });
});

describe("isEligiblePaymentMethod — type guard", () => {
  it("accepts an enabled method", () => {
    expect(isEligiblePaymentMethod("COD", ALL_ON)).toBe(true);
  });

  it("rejects a disabled method", () => {
    expect(isEligiblePaymentMethod("ONLINE", { ...ALL_ON, sandboxPaymentEnabled: false })).toBe(false);
  });

  it("rejects unknown methods and empty values", () => {
    expect(isEligiblePaymentMethod("CRYPTO", ALL_ON)).toBe(false);
    expect(isEligiblePaymentMethod(null, ALL_ON)).toBe(false);
    expect(isEligiblePaymentMethod(undefined, ALL_ON)).toBe(false);
  });
});
