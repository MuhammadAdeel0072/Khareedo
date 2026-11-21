// Stage 3 API audit — route-level tests for the error-mapping fixes
// (H-1/M-1 cart, M-2 place-order, M-4 order status, M-5 coupon /
// promotion / banner 404s, M-6 inventory 404s, M-8 refund mapping,
// L-1 enqueue messages, L-2 JSON 500s, L-3 payment-review 404,
// L-4 db-target gate, L-5 1 MiB body cap). Services are mocked: these
// tests pin the HTTP contract, not the service semantics.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TestAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  class TestMfaRequiredError extends Error {
    code: "MFA_ENROLLMENT_REQUIRED" | "MFA_VERIFICATION_REQUIRED";
    status: number;
    constructor(
      code: "MFA_ENROLLMENT_REQUIRED" | "MFA_VERIFICATION_REQUIRED",
      message: string,
      status = 401
    ) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  const prismaError = (code: string, message = "synthetic prisma error") =>
    Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", code });
  return {
    TestAuthError,
    TestMfaRequiredError,
    prismaError,
    getCartDetails: vi.fn(),
    addToCart: vi.fn(),
    removeCartItem: vi.fn(),
    applyCartItemUpdate: vi.fn(),
    placeOrder: vi.fn(),
    getSessionUser: vi.fn(),
    requireUser: vi.fn(),
    requireAdmin: vi.fn(),
    adminUpdateOrderStatus: vi.fn(),
    customerCancelOrder: vi.fn(),
    adminUpdateCoupon: vi.fn(),
    adminDeleteCoupon: vi.fn(),
    adminUpdatePromotion: vi.fn(),
    adminUpdateBanner: vi.fn(),
    adminDeleteBanner: vi.fn(),
    adminUpdateInventory: vi.fn(),
    registerUser: vi.fn(),
    updateProfile: vi.fn(),
    couponFindFirst: vi.fn(),
    promotionDelete: vi.fn(),
    requestRefund: vi.fn(),
    getRefund: vi.fn(),
    listRefunds: vi.fn(),
    loadSafepayConfig: vi.fn(),
    providerFactory: vi.fn(),
    refundFactory: vi.fn(),
    resolveReviewHold: vi.fn(),
    listReviewCases: vi.fn(),
    maintenanceRunner: { run: vi.fn() },
    deliverOutbox: vi.fn(),
    retryOutbox: vi.fn(),
    requestPasswordReset: vi.fn(),
    resendVerificationEmail: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true, retryAfterSec: 0 }),
  clientIp: () => "test-ip",
}));
vi.mock("@/lib/auth-guard", () => ({
  getSessionUser: mocks.getSessionUser,
  requireUser: mocks.requireUser,
  requireAdminMfaVerified: mocks.requireAdmin,
  requireAdmin: mocks.requireAdmin,
  AuthError: mocks.TestAuthError,
  MfaRequiredError: mocks.TestMfaRequiredError,
}));
vi.mock("@/lib/db", () => ({
  db: {
    coupon: { findFirst: mocks.couponFindFirst },
    promotion: { delete: mocks.promotionDelete },
  },
}));
vi.mock("@/services/cart.service", () => ({
  getCartDetails: mocks.getCartDetails,
  addToCart: mocks.addToCart,
  removeCartItem: mocks.removeCartItem,
  applyCartItemUpdate: mocks.applyCartItemUpdate,
}));
vi.mock("@/services/checkout.service", () => ({ placeOrder: mocks.placeOrder }));
vi.mock("@/services/orders.service", () => ({
  adminUpdateOrderStatus: mocks.adminUpdateOrderStatus,
  customerCancelOrder: mocks.customerCancelOrder,
}));
vi.mock("@/services/promotions.service", () => ({
  adminUpdateCoupon: mocks.adminUpdateCoupon,
  adminDeleteCoupon: mocks.adminDeleteCoupon,
  adminUpdatePromotion: mocks.adminUpdatePromotion,
}));
vi.mock("@/services/banners.service", () => ({
  adminUpdateBanner: mocks.adminUpdateBanner,
  adminDeleteBanner: mocks.adminDeleteBanner,
}));
vi.mock("@/services/inventory.service", () => ({
  adminUpdateInventory: mocks.adminUpdateInventory,
}));
vi.mock("@/services/users.service", () => ({
  registerUser: mocks.registerUser,
  updateProfile: mocks.updateProfile,
}));
vi.mock("@/services/admin-audit.service", () => ({
  ADMIN_AUDIT_ACTIONS: {
    ORDER_STATUS_CHANGED: "ORDER_STATUS_CHANGED",
    COUPON_UPDATED: "COUPON_UPDATED",
    COUPON_DELETED: "COUPON_DELETED",
    PROMOTION_UPDATED: "PROMOTION_UPDATED",
    PROMOTION_DELETED: "PROMOTION_DELETED",
    BANNER_UPDATED: "BANNER_UPDATED",
    BANNER_DELETED: "BANNER_DELETED",
    INVENTORY_UPDATED: "INVENTORY_UPDATED",
    PAYMENT_REFUND_REQUESTED: "PAYMENT_REFUND_REQUESTED",
    PAYMENT_MAINTENANCE_RUN: "PAYMENT_MAINTENANCE_RUN",
    EMAIL_OUTBOX_DELIVERY_RUN: "EMAIL_OUTBOX_DELIVERY_RUN",
    EMAIL_OUTBOX_RETRIED: "EMAIL_OUTBOX_RETRIED",
  },
  adminAuditContext: vi.fn(() => ({ actor: "test-admin" })),
  recordAdminAuditBestEffort: vi.fn(async () => undefined),
}));
vi.mock("@/lib/safepay/config", () => ({
  loadSafepayConfig: mocks.loadSafepayConfig,
  SafepayConfigurationError: class SafepayConfigurationError extends Error {},
}));
vi.mock("@/lib/safepay/provider", () => ({ createSafepayProvider: mocks.providerFactory }));
vi.mock("@/services/payment-refund.service", () => ({
  createPaymentRefundService: mocks.refundFactory,
  REFUND_SERVICE_OPTIONS: {
    pollDelayMs: 60_000, maxConfirmationAttempts: 6, submitGraceMs: 120_000,
    reversalWindowMs: 24 * 3_600_000, cardRefundWindowMs: 90 * 24 * 3_600_000,
  },
}));
vi.mock("@/services/payment-review.service", () => ({
  createPaymentReviewService: () => ({ resolvePaymentReviewHold: mocks.resolveReviewHold }),
  listPaymentReviewCases: mocks.listReviewCases,
}));
vi.mock("@/services/payment-maintenance.service", () => ({
  createPaymentMaintenanceRunner: () => mocks.maintenanceRunner,
  MAINTENANCE_ACTIONS: ["expire_reservations", "verify_order_payment"],
}));
vi.mock("@/services/email-outbox.service", () => ({
  deliverPendingOutboxEmails: mocks.deliverOutbox,
  retryEmailOutboxEntry: mocks.retryOutbox,
}));
vi.mock("@/services/password-reset.service", () => ({
  requestPasswordReset: mocks.requestPasswordReset,
}));
vi.mock("@/services/email-verification.service", () => ({
  resendVerificationEmail: mocks.resendVerificationEmail,
}));

import { GET as cartGET, POST as cartPOST, PATCH as cartPATCH } from "@/app/api/cart/route";
import { POST as placePOST } from "@/app/api/checkout/place/route";
import { PATCH as orderStatusPATCH } from "@/app/api/admin/orders/[id]/status/route";
import { PUT as couponPUT, DELETE as couponDELETE } from "@/app/api/admin/coupons/[id]/route";
import { PUT as promotionPUT, DELETE as promotionDELETE } from "@/app/api/admin/promotions/[id]/route";
import { PUT as bannerPUT, DELETE as bannerDELETE } from "@/app/api/admin/banners/[id]/route";
import { PUT as inventoryPUT } from "@/app/api/admin/inventory/route";
import { POST as registerPOST } from "@/app/api/register/route";
import { PUT as profilePUT } from "@/app/api/account/profile/route";
import { POST as cancelPOST } from "@/app/api/account/orders/[id]/cancel/route";
import { POST as refundsPOST, GET as refundsGET } from "@/app/api/admin/payments/refunds/route";
import { GET as refundGET } from "@/app/api/admin/payments/refunds/[id]/route";
import { GET as reviewGET, POST as reviewPOST } from "@/app/api/admin/payments/review/route";
import { POST as maintenancePOST } from "@/app/api/admin/payments/maintenance/route";
import { POST as outboxDeliverPOST } from "@/app/api/admin/email-outbox/deliver/route";
import { POST as forgotPOST } from "@/app/api/auth/forgot-password/route";
import { POST as resendPOST } from "@/app/api/auth/resend-verification/route";
import { GET as dbTargetGET } from "@/app/api/db-target/route";

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const adminCtx = { params: Promise.resolve({ id: "missing-id" }) };
const sandboxConfig = {
  environment: "sandbox", merchantAccountRef: "synthetic-account",
  merchantApiKey: () => "synthetic-public", requestHeaders: () => new Headers(),
  signReturnState: () => Buffer.alloc(32), siteOrigin: "https://shop.example.invalid",
  apiOrigin: "https://sandbox.api.getsafepay.com",
  checkoutUrl: "https://sandbox.api.getsafepay.com/embedded/",
};

const placeBody = {
  idempotencyKey: "stage3-place-order-00001",
  customer: { name: "Test Buyer", email: "buyer@example.invalid", phone: "03001234567" },
  address: { fullName: "Test Buyer", phone: "03001234567", line1: "Test Street 1", city: "Lahore", province: "Punjab" },
  deliveryMethod: "STANDARD",
  paymentMethod: "COD",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: "user-1" });
  mocks.requireUser.mockResolvedValue({ id: "user-1", email: "u@example.invalid", role: "CUSTOMER" });
  mocks.requireAdmin.mockResolvedValue({ id: "admin-1", email: "a@example.invalid", role: "ADMIN" });
  mocks.couponFindFirst.mockResolvedValue(null);
  mocks.loadSafepayConfig.mockReturnValue(sandboxConfig);
  mocks.providerFactory.mockReturnValue({});
  mocks.refundFactory.mockReturnValue({
    requestRefund: mocks.requestRefund,
    getRefund: mocks.getRefund,
    listRefunds: mocks.listRefunds,
  });
  mocks.getRefund.mockResolvedValue(null);
  mocks.listReviewCases.mockResolvedValue([]);
  mocks.maintenanceRunner.run.mockResolvedValue({ ok: true });
  mocks.deliverOutbox.mockResolvedValue({ delivered: 0 });
  mocks.retryOutbox.mockResolvedValue(true);
});

describe("H-1/M-1 — cart write errors", () => {
  it("maps a transient DB failure (P1001) to 503 with Retry-After and no leak", async () => {
    mocks.addToCart.mockRejectedValue(mocks.prismaError("P1001", "Can't reach database server at db.example.invalid:5432"));
    const res = await cartPOST(jsonRequest("http://localhost/api/cart", "POST", { productId: "p1", quantity: 1 }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = await res.json();
    expect(body).toMatchObject({ ok: false });
    expect(JSON.stringify(body)).not.toContain("P1001");
    expect(JSON.stringify(body)).not.toContain("db.example.invalid");
  });

  it("keeps a genuine stock conflict at 409 with its message", async () => {
    mocks.addToCart.mockRejectedValue(new Error("Only 2 unit(s) available in stock"));
    const res = await cartPOST(jsonRequest("http://localhost/api/cart", "POST", { productId: "p1", quantity: 5 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Only 2 unit(s) available in stock");
  });

  it("maps an unexpected failure to a generic 500 without leaking internals", async () => {
    mocks.addToCart.mockRejectedValue(new Error("boom: SELECT * FROM secret_table leaked"));
    const res = await cartPOST(jsonRequest("http://localhost/api/cart", "POST", { productId: "p1", quantity: 1 }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Something went wrong. Please try again.");
    expect(JSON.stringify(body)).not.toContain("secret_table");
  });

  it("maps pool-timeout contention on PATCH to 503, not 409", async () => {
    mocks.applyCartItemUpdate.mockRejectedValue(mocks.prismaError("P2024", "Timed out fetching a new connection from the pool"));
    const res = await cartPATCH(jsonRequest("http://localhost/api/cart", "PATCH", { itemId: "item-1", quantity: 2 }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("answers a DB outage on GET with a JSON 500 and no leak", async () => {
    mocks.getCartDetails.mockRejectedValue(mocks.prismaError("P1001", "Can't reach database server"));
    const res = await cartGET(new Request("http://localhost/api/cart"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(await res.json())).not.toContain("P1001");
  });
});

describe("M-2 — place-order generic DB failure", () => {
  it("maps ERROR (generic DB failure) to 503 with Retry-After, not 422", async () => {
    mocks.placeOrder.mockResolvedValue({ ok: false, error: "Something went wrong while placing your order. Please try again.", code: "ERROR" });
    const res = await placePOST(jsonRequest("http://localhost/api/checkout/place", "POST", placeBody));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({ code: "ERROR" });
  });

  it("keeps BUSY at 503, DUPLICATE at 409, and business failures at 422", async () => {
    mocks.placeOrder.mockResolvedValue({ ok: false, error: "The store is busy right now — please try again in a moment.", code: "BUSY" });
    expect((await placePOST(jsonRequest("http://localhost/api/checkout/place", "POST", placeBody))).status).toBe(503);
    mocks.placeOrder.mockResolvedValue({ ok: false, error: "Duplicate order submission detected.", code: "DUPLICATE" });
    expect((await placePOST(jsonRequest("http://localhost/api/checkout/place", "POST", placeBody))).status).toBe(409);
    mocks.placeOrder.mockResolvedValue({ ok: false, error: "Your cart is empty.", code: "EMPTY_CART" });
    expect((await placePOST(jsonRequest("http://localhost/api/checkout/place", "POST", placeBody))).status).toBe(422);
  });
});

describe("M-4 — admin order status on a missing order", () => {
  it("returns 404 for a missing order and 409 for an invalid transition", async () => {
    mocks.adminUpdateOrderStatus.mockResolvedValue({ ok: false, error: "Order not found.", code: "NOT_FOUND" });
    const missing = await orderStatusPATCH(
      jsonRequest("http://localhost/api/admin/orders/missing-id/status", "PATCH", { status: "CONFIRMED" }),
      { params: Promise.resolve({ id: "missing-id" }) }
    );
    expect(missing.status).toBe(404);
    mocks.adminUpdateOrderStatus.mockResolvedValue({ ok: false, error: "Invalid transition." });
    const invalid = await orderStatusPATCH(
      jsonRequest("http://localhost/api/admin/orders/order-1/status", "PATCH", { status: "DELIVERED" }),
      { params: Promise.resolve({ id: "order-1" }) }
    );
    expect(invalid.status).toBe(409);
  });
});

describe("M-5 — coupon / promotion / banner P2025 → 404", () => {
  const couponBody = { code: "SAVE10", type: "PERCENT", value: 10 };
  const promotionBody = { title: "Sale", type: "PERCENT", value: 10 };
  const bannerBody = { title: "Sale", imageUrl: "/banners/sale.jpg", placement: "HERO", isActive: true, sortOrder: 1 };

  it("maps a missing coupon (PUT and DELETE) to 404", async () => {
    mocks.adminUpdateCoupon.mockRejectedValue(mocks.prismaError("P2025", "Record to update not found."));
    const put = await couponPUT(jsonRequest("http://localhost/api/admin/coupons/missing-id", "PUT", couponBody), adminCtx);
    expect(put.status).toBe(404);
    expect((await put.json()).error).toBe("Coupon not found.");
    mocks.adminDeleteCoupon.mockRejectedValue(mocks.prismaError("P2025", "Record to delete not found."));
    expect((await couponDELETE(new Request("http://localhost/api/admin/coupons/missing-id", { method: "DELETE" }), adminCtx)).status).toBe(404);
  });

  it("maps a missing promotion (PUT and DELETE) to 404", async () => {
    mocks.adminUpdatePromotion.mockRejectedValue(mocks.prismaError("P2025", "Record to update not found."));
    const put = await promotionPUT(jsonRequest("http://localhost/api/admin/promotions/missing-id", "PUT", promotionBody), adminCtx);
    expect(put.status).toBe(404);
    mocks.promotionDelete.mockRejectedValue(mocks.prismaError("P2025", "Record to delete not found."));
    expect((await promotionDELETE(new Request("http://localhost/api/admin/promotions/missing-id", { method: "DELETE" }), adminCtx)).status).toBe(404);
  });

  it("maps a missing banner (PUT and DELETE) to 404", async () => {
    mocks.adminUpdateBanner.mockRejectedValue(mocks.prismaError("P2025", "Record to update not found."));
    const put = await bannerPUT(jsonRequest("http://localhost/api/admin/banners/missing-id", "PUT", bannerBody), adminCtx);
    expect(put.status).toBe(404);
    mocks.adminDeleteBanner.mockRejectedValue(mocks.prismaError("P2025", "Record to delete not found."));
    expect((await bannerDELETE(new Request("http://localhost/api/admin/banners/missing-id", { method: "DELETE" }), adminCtx)).status).toBe(404);
  });
});

describe("M-6 — inventory 404s (route mapping)", () => {
  it("maps a missing product / variant to 404 and keeps validation at 422", async () => {
    mocks.adminUpdateInventory.mockResolvedValue({ ok: false, error: "Product not found", code: "NOT_FOUND" });
    const missing = await inventoryPUT(jsonRequest("http://localhost/api/admin/inventory", "PUT", { productId: "nope", quantity: 5 }));
    expect(missing.status).toBe(404);
    mocks.adminUpdateInventory.mockResolvedValue({ ok: false, error: "Variant not found", code: "VARIANT_NOT_FOUND" });
    expect((await inventoryPUT(jsonRequest("http://localhost/api/admin/inventory", "PUT", { productId: "p1", variantId: "nope", quantity: 5 }))).status).toBe(404);
    mocks.adminUpdateInventory.mockResolvedValue({ ok: false, error: "Stock cannot be negative" });
    expect((await inventoryPUT(jsonRequest("http://localhost/api/admin/inventory", "PUT", { productId: "p1", quantity: -1 }))).status).toBe(422);
  });
});

describe("M-8 — refund rejection mapping", () => {
  const refundBody = { paymentId: "payment-1" };

  it("maps PAYMENT_NOT_FOUND to 404, INVALID_INPUT to 422, TRANSIENT to 503", async () => {
    mocks.requestRefund.mockResolvedValue({ kind: "rejected", code: "PAYMENT_NOT_FOUND" });
    expect((await refundsPOST(jsonRequest("http://localhost/api/admin/payments/refunds", "POST", refundBody))).status).toBe(404);
    mocks.requestRefund.mockResolvedValue({ kind: "rejected", code: "INVALID_INPUT" });
    expect((await refundsPOST(jsonRequest("http://localhost/api/admin/payments/refunds", "POST", refundBody))).status).toBe(422);
    mocks.requestRefund.mockResolvedValue({ kind: "rejected", code: "TRANSIENT" });
    const transient = await refundsPOST(jsonRequest("http://localhost/api/admin/payments/refunds", "POST", refundBody));
    expect(transient.status).toBe(503);
    expect(transient.headers.get("retry-after")).toBe("5");
    expect((await transient.json()).code).toBe("TRANSIENT");
  });
});

describe("L-1 — enqueue-failure messages (register already fixed: verified)", () => {
  it("does not describe a forgot-password enqueue failure as a send failure", async () => {
    mocks.requestPasswordReset.mockRejectedValue(new Error("P1001 Can't reach database server"));
    const res = await forgotPOST(jsonRequest("http://localhost/api/auth/forgot-password", "POST", { email: "u@example.invalid" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Something went wrong while processing your request. Please try again later.");
    expect(body.error).not.toContain("send");
  });

  it("does not describe a resend-verification enqueue failure as a send failure", async () => {
    mocks.resendVerificationEmail.mockRejectedValue(new Error("P1001 Can't reach database server"));
    const res = await resendPOST(jsonRequest("http://localhost/api/auth/resend-verification", "POST", { email: "u@example.invalid" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Something went wrong while processing your request. Please try again later.");
    expect(body.error).not.toContain("send");
  });

  it("register still uses the corrected message (no re-change)", async () => {
    mocks.registerUser.mockRejectedValue(new Error("P1001 Can't reach database server"));
    const res = await registerPOST(jsonRequest("http://localhost/api/register", "POST", {
      name: "Test User", email: "u@example.invalid", password: "Correct-Horse-1",
    }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Something went wrong while creating your account. Please try again.");
  });
});

describe("L-2 — JSON 500s, not HTML, on unexpected throws", () => {
  it("refunds GET returns a JSON 500 when the service throws", async () => {
    mocks.listRefunds.mockRejectedValue(new Error("P1001 Can't reach database server"));
    const res = await refundsGET(new Request("http://localhost/api/admin/payments/refunds"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(await res.json())).not.toContain("P1001");
  });

  it("refund status GET returns a JSON 500 when the service throws", async () => {
    mocks.getRefund.mockRejectedValue(new Error("boom"));
    const res = await refundGET(new Request("http://localhost/api/admin/payments/refunds/refund-1"), { params: Promise.resolve({ id: "refund-1" }) });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("payment-review GET returns a JSON 500 when the service throws", async () => {
    mocks.listReviewCases.mockRejectedValue(new Error("boom"));
    const res = await reviewGET();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("maintenance POST returns a JSON 500 when the runner throws", async () => {
    mocks.maintenanceRunner.run.mockRejectedValue(new Error("boom"));
    const res = await maintenancePOST(jsonRequest("http://localhost/api/admin/payments/maintenance", "POST", { action: "expire_reservations" }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("outbox deliver POST returns a JSON 500 when delivery throws", async () => {
    mocks.deliverOutbox.mockRejectedValue(new Error("boom"));
    const res = await outboxDeliverPOST(jsonRequest("http://localhost/api/admin/email-outbox/deliver", "POST", {}));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("L-3 — payment-review unknown order", () => {
  it("returns 404 for ORDER_NOT_FOUND and keeps NOT_ELIGIBLE at 409", async () => {
    mocks.resolveReviewHold.mockResolvedValue({ ok: false, code: "ORDER_NOT_FOUND" });
    const missing = await reviewPOST(jsonRequest("http://localhost/api/admin/payments/review", "POST", { orderId: "missing-order", outcome: "NOT_CAPTURED" }));
    expect(missing.status).toBe(404);
    mocks.resolveReviewHold.mockResolvedValue({ ok: false, code: "NOT_ELIGIBLE" });
    expect((await reviewPOST(jsonRequest("http://localhost/api/admin/payments/review", "POST", { orderId: "order-1", outcome: "NOT_CAPTURED" }))).status).toBe(409);
  });
});

describe("L-4 — db-target gate", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedUrl = process.env.SUPABASE_POSTGRES_URL;

  it("answers 404 in production and the boolean elsewhere", async () => {
    const env = process.env as Record<string, string | undefined>;
    process.env.SUPABASE_POSTGRES_URL = "postgresql://postgres:secret@localhost:5432/postgres";
    env.NODE_ENV = "production";
    const prod = await dbTargetGET();
    expect(prod.status).toBe(404);
    expect((await prod.json()).error).toBe("Not found.");
    env.NODE_ENV = "test";
    const dev = await dbTargetGET();
    expect(dev.status).toBe(200);
    expect(await dev.json()).toEqual({ databaseIsLoopback: true });
    env.NODE_ENV = savedNodeEnv;
    if (savedUrl === undefined) delete process.env.SUPABASE_POSTGRES_URL;
    else process.env.SUPABASE_POSTGRES_URL = savedUrl;
  });
});

describe("L-5 — 1 MiB body cap", () => {
  const huge = "x".repeat(2 * 1024 * 1024);

  it("rejects an oversized profile body with 413 before the service runs", async () => {
    mocks.updateProfile.mockResolvedValue({ ok: true });
    const res = await profilePUT(jsonRequest("http://localhost/api/account/profile", "PUT", { name: "Test User", pad: huge }));
    expect(res.status).toBe(413);
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects an oversized register body with 413", async () => {
    mocks.registerUser.mockResolvedValue({ ok: true });
    const res = await registerPOST(jsonRequest("http://localhost/api/register", "POST", {
      name: "Test User", email: "u@example.invalid", password: "Correct-Horse-1", pad: huge,
    }));
    expect(res.status).toBe(413);
    expect(mocks.registerUser).not.toHaveBeenCalled();
  });

  it("rejects an oversized inventory body with 413", async () => {
    mocks.adminUpdateInventory.mockResolvedValue({ ok: true });
    const res = await inventoryPUT(jsonRequest("http://localhost/api/admin/inventory", "PUT", { productId: "p1", quantity: 5, pad: huge }));
    expect(res.status).toBe(413);
    expect(mocks.adminUpdateInventory).not.toHaveBeenCalled();
  });

  it("rejects an oversized order-status body with 413", async () => {
    mocks.adminUpdateOrderStatus.mockResolvedValue({ ok: true });
    const res = await orderStatusPATCH(
      jsonRequest("http://localhost/api/admin/orders/order-1/status", "PATCH", { status: "CONFIRMED", pad: huge }),
      { params: Promise.resolve({ id: "order-1" }) }
    );
    expect(res.status).toBe(413);
    expect(mocks.adminUpdateOrderStatus).not.toHaveBeenCalled();
  });

  it("rejects an oversized cancel body with 413", async () => {
    mocks.customerCancelOrder.mockResolvedValue({ ok: true, order: {}, alreadyCancelled: false });
    const res = await cancelPOST(
      jsonRequest("http://localhost/api/account/orders/order-1/cancel", "POST", { reason: huge }),
      { params: Promise.resolve({ id: "order-1" }) }
    );
    expect(res.status).toBe(413);
    expect(mocks.customerCancelOrder).not.toHaveBeenCalled();
  });

  it("rejects an oversized refund body with 413 and keeps invalid JSON at 400", async () => {
    const big = await refundsPOST(jsonRequest("http://localhost/api/admin/payments/refunds", "POST", { paymentId: "payment-1", pad: huge }));
    expect(big.status).toBe(413);
    expect((await big.json()).code).toBe("BODY_TOO_LARGE");
    const bad = await refundsPOST(new Request("http://localhost/api/admin/payments/refunds", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
    }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("INVALID_BODY");
  });

  it("rejects an oversized payment-review body with 413", async () => {
    const res = await reviewPOST(jsonRequest("http://localhost/api/admin/payments/review", "POST", { orderId: "order-1", outcome: "NOT_CAPTURED", pad: huge }));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("BODY_TOO_LARGE");
  });
});
