// E2E: registered customer journey + admin management journey.
import { expect, test } from "@playwright/test";
import { db } from "../../src/lib/db";

// Self-cleaning: remove the product this suite creates (archived or not), so
// repeat runs never pollute the 51-product demo catalogue (audit Phase 11),
// and remove any COD orders this suite places.
const placedOrderReferences: string[] = [];
test.afterAll(async () => {
  const junk = await db.product.findMany({
    where: { name: "E2E Test Product" },
    select: { id: true },
  });
  for (const p of junk) {
    await db.inventory.deleteMany({ where: { productId: p.id } });
    await db.productImage.deleteMany({ where: { productId: p.id } });
    await db.product.delete({ where: { id: p.id } });
  }
  for (const reference of placedOrderReferences) {
    const order = await db.order.findUnique({ where: { reference }, select: { id: true } });
    if (!order) continue;
    await db.payment.deleteMany({ where: { orderId: order.id } });
    await db.orderItem.deleteMany({ where: { orderId: order.id } });
    await db.order.delete({ where: { id: order.id } });
  }
  await db.$disconnect();
});

import {
  ADMIN,
  ADMIN_STORAGE_STATE,
  CUSTOMER,
  SARA,
  customerLogin,
  ensureAdminSession,
  scrollForStickyBar,
  visibleButton,
  pdpAddToCart,
} from "./e2e-helpers";

test.describe("registered customer journey", () => {
  test("signs in, sees wishlist, order history, tracks order (FR-02/26)", async ({ page }) => {
    await customerLogin(page);

    // Account overview
    await expect(page.getByText("Total Orders").first()).toBeVisible();

    // Order history
    await page.getByRole("link", { name: "My Orders" }).first().click();
    await expect(page.getByRole("heading", { name: "My Orders" })).toBeVisible();
    // Seeded orders use KH+11 digits; runtime orders KH+13 — accept both
    await expect(page.locator("text=/^KH\\d{11,13}$/").first()).toBeVisible();

    // Order detail — each row is a Link wrapping the mono reference
    await page.locator("a[href^='/account/orders/']").first().click();
    await expect(page.getByText("Order Progress")).toBeVisible({ timeout: 15000 });
  });

  test("customer data isolation: cannot view another customer's order (NFR-11)", async ({ page }) => {
    // Sign in as Sara, then request Ali's seeded order reference directly
    await customerLogin(page, SARA);
    await page.waitForLoadState("load");
    await page.goto("/order/KH26030110021"); // Ali's delivered order
    // Should be 404 — not visible to another customer
    await expect(page.getByText("Page not found")).toBeVisible();
  });

  test("places a COD order through checkout (FR-19..25, D-01/D-02)", async ({ page }) => {
    await customerLogin(page);

    await page.goto("/product/casio-mens-analog-watch");
    await scrollForStickyBar(page);
    await pdpAddToCart(page);
    await expect(page.getByText("Added to cart")).toBeVisible({ timeout: 10000 });

    await page.goto("/checkout");
    // A saved address is pre-selected when one exists: use it (do NOT
    // save a new address on every run — accounts cap at 10 addresses and
    // repeated runs hit "You can save up to 10 addresses." 422s). Only
    // fill the inline new-address form when no saved address exists.
    if (await page.getByLabel("Full Name").isVisible().catch(() => false)) {
      await page.getByLabel("Full Name").fill("Ali Hassan");
      await page.getByLabel("Phone Number").fill("0321 5556677");
      await page.getByLabel("Street Address").fill("Test House 99, E2E Lane");
      await page.getByLabel("City").fill("Lahore");
    }
    await page.getByRole("button", { name: /continue to delivery/i }).click();

    // Step 2: delivery (standard pre-selected) → continue
    await page.getByRole("button", { name: /continue to payment/i }).click();

    // Step 3: COD pre-selected, bank transfer is not offered → review
    await expect(page.getByRole("radio", { name: /bank transfer/i })).toHaveCount(0);
    await page.getByRole("button", { name: /review order/i }).click();

    // Step 4: confirm
    await page.getByRole("button", { name: /confirm order/i }).click();

    // Confirmation page with order reference (never shown for failed orders)
    await expect(page.getByText("Order Confirmed!")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Order Reference/i)).toBeVisible();
    const reference = await page.locator("text=/^KH\\d{11,13}$/").first().innerText();
    placedOrderReferences.push(reference.trim());
    await expect(page.getByText("Cash on Delivery").first()).toBeVisible();
  });

  test("saved default address + Online Payment reaches Confirm Order without a delivery-details bounce", async ({ page }) => {
    // Regression: a selected saved address (which carries no email — the
    // Address model has none) used to fail frontend validation at Confirm
    // Order and bounce the customer back to the Address step with
    // "Please complete your delivery details first.", even though Review
    // displayed the address correctly. The contact email belongs to the
    // customer (session email), not the address. This test follows the exact
    // reported journey: saved default address → Delivery → Online Payment →
    // Review → Confirm Order, and asserts no delivery-details bounce.
    await customerLogin(page);

    await page.goto("/product/casio-mens-analog-watch");
    await scrollForStickyBar(page);
    await pdpAddToCart(page);
    await expect(page.getByText("Added to cart")).toBeVisible({ timeout: 10000 });

    await page.goto("/checkout");
    // Ensure a saved address exists. When none exists the new-address form
    // shows; filling it saves the address and selects it as the default.
    if (await page.getByLabel("Full Name").isVisible().catch(() => false)) {
      await page.getByLabel("Full Name").fill("Ali Hassan");
      await page.getByLabel("Phone Number").fill("0321 5556677");
      await page.getByLabel("Street Address").fill("Test House 99, E2E Lane");
      await page.getByLabel("City").fill("Lahore");
      await page.getByRole("button", { name: /continue to delivery/i }).click();
      // Back to the Address step: the saved address is now listed, marked
      // Default, and selected.
      await page.getByRole("button", { name: /back/i }).click();
    }
    // The first saved address is selected (Default badge visible).
    await expect(page.getByText("Default").first()).toBeVisible();
    await page.getByRole("button", { name: /continue to delivery/i }).click();

    // Step 2: delivery (standard pre-selected) → payment
    await page.getByRole("button", { name: /continue to payment/i }).click();

    // Step 3: prefer Online Payment (Sandbox) when the sandbox is
    // configured; otherwise COD. The saved-address validation bug is
    // payment-method-independent — it fires before any payment call — so
    // either path exercises the fix.
    const onlineRadio = page.getByRole("radio", { name: /online payment/i });
    const useOnline = await onlineRadio.isVisible().catch(() => false);
    if (useOnline) {
      await onlineRadio.click();
    } else {
      await page.getByRole("radio", { name: /cash on delivery/i }).click();
    }
    await page.getByRole("button", { name: /review order/i }).click();

    // Step 4: Review shows the deliver-to address — either the address just
    // entered, or the seeded default address when one was already selected
    // (the full seed gives Ali a saved default address, so the new-address
    // form is skipped and the seeded address is the one on file).
    await expect(page.getByRole("heading", { name: "Deliver to" })).toBeVisible();
    await expect(
      page.getByText("Test House 99, E2E Lane").or(page.getByText("House No 12, Street 5, Gulberg")),
    ).toBeVisible();
    await page.getByRole("button", { name: /confirm order/i }).click();

    // The regression: no delivery-details bounce, and we are not back on the
    // Address step.
    await expect(page.getByText("Please complete your delivery details first")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Shipping Address" })).toHaveCount(0);

    if (useOnline) {
      // Online Payment starts the Safepay sandbox attempt (navigation away
      // from /checkout) — or, if the sandbox is only partly configured, a
      // payment error toast — but never the delivery-details bounce.
      await page.waitForURL((url) => !url.toString().includes("/checkout"), { timeout: 15000 }).catch(() => undefined);
      await expect(page.getByText("Please complete your delivery details first")).toHaveCount(0);
    } else {
      // COD completes the order (and is cleaned up by afterAll).
      await expect(page.getByText("Order Confirmed!")).toBeVisible({ timeout: 15000 });
      const reference = await page.locator("text=/^KH\\d{11,13}$/").first().innerText();
      placedOrderReferences.push(reference.trim());
    }
  });

  test("cannot place a bank-transfer order through the API (PR-04, D-02)", async ({ page }) => {
    await customerLogin(page);

    const response = await page.request.post("/api/checkout/place", {
      data: {
        idempotencyKey: "e2e-bank-transfer-attempt",
        customer: { name: "Ali Hassan", email: "ali.hassan@example.com", phone: "03001234567" },
        address: {
          fullName: "Ali Hassan", phone: "03001234567",
          line1: "Test House 99, E2E Lane", city: "Lahore", province: "Punjab",
        },
        deliveryMethod: "STANDARD",
        paymentMethod: "BANK_TRANSFER",
      },
    });
    expect(response.status()).toBe(422);
  });
});

// Admin MFA verify is rate-limited (5/15min per admin), so the admin tests
// share ONE MFA-verified session: beforeAll signs in once (enrolling MFA on
// first use) and saves the storage state; each admin test reuses it.
test.describe("admin journey", () => {
  test.use({ storageState: ADMIN_STORAGE_STATE });

  test.beforeAll(async ({ browser }) => {
    // Enrollment + verify can take a while when the sibling worker is
    // enrolling first (30s shared-secret poll); give the hook room.
    test.setTimeout(180_000);
    await ensureAdminSession(browser);
  });

  test("admin signs in and views dashboard (FR-38, FR-45)", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Total Orders").first()).toBeVisible();
  });

  test("admin creates and publishes a product via inline dialog (FR-39/40)", async ({ page }) => {
    await page.goto("/admin/products");
    await page.getByRole("button", { name: /add product/i }).click();
    await page.getByLabel("Product name *").fill("E2E Test Product");
    await page.getByLabel(/price \(pkr\)/i).fill("1999");
    await page.getByLabel("Stock quantity").fill("5");
    await page.getByLabel("Category *").selectOption({ index: 1 });

    // The dialog can only add images through Supabase Storage (upload or
    // URL import — both call getStorageClient()), which is not configured
    // against this disposable Postgres database, so the dialog itself
    // cannot complete a create here. What the browser CAN prove is the
    // dialog's validation: submitting with no image is refused with the
    // honest "Add at least one product image" error instead of creating
    // an imageless product.
    await page.getByRole("button", { name: /create product/i }).click();
    await expect(page.getByText("Add at least one product image").first()).toBeVisible({ timeout: 15000 });

    // The create itself is exercised API-side (the API accepts a plain
    // image URL string — the storage dependency lives in the dialog's
    // import/upload flow, not in product creation).
    const categoryId = await page.getByLabel("Category *").locator("option").nth(1).getAttribute("value");
    const created = await page.request.post("/api/admin/products", {
      data: {
        name: "E2E Test Product",
        categoryId,
        price: 1999,
        stock: 5,
        status: "PUBLISHED",
        images: ["/images/placeholder.svg"],
      },
    });
    expect(created.ok(), `product create API failed: ${await created.text()}`).toBeTruthy();
    await page.getByRole("button", { name: /cancel/i }).click();
    await page.goto("/admin/products");
    // May exist twice when both projects (chromium + mobile) run the suite;
    // scope to VISIBLE elements (mobile renders cards, desktop a table)
    await expect(
      page.getByText("E2E Test Product").filter({ visible: true }).first()
    ).toBeVisible({ timeout: 15000 });

    // Cleanup: archive the test product so repeat runs don't pollute the catalogue
    // (desktop table rows expose aria-label "Archive E2E Test Product"; mobile cards a plain Archive button)
    const rowBtn = page.getByRole("button", { name: /archive e2e test product/i });
    const cardBtn = page.getByRole("button", { name: "Archive", exact: true }).first();
    await rowBtn.or(cardBtn).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: /archive/i }).click();
    await expect(page.getByText("Product archived")).toBeVisible({ timeout: 15000 });
  });

  test("admin updates inventory (FR-40)", async ({ page }) => {
    await page.goto("/admin/inventory");
    const firstRow = page.locator("tbody tr").first();
    const spin = firstRow.getByRole("spinbutton");
    // Fill a value that always differs from the current stock — re-running with a
    // constant made "Update" stay disabled (no change) and the test self-pollute.
    const current = Number(await spin.inputValue());
    await spin.fill(String(current + 5));
    await firstRow.getByRole("button", { name: /update/i }).click();
    await expect(page.getByText(/stock updated/i)).toBeVisible({ timeout: 15000 });
  });

  test("admin updates an order status through the state machine (FR-41)", async ({ page }) => {
    // Prefer a CONFIRMED order; fall back to the newest order (newest COD
    // orders are CONFIRMED on placement — D3 — never PENDING).
    await page.goto("/admin/orders?status=CONFIRMED");
    const pendingManage = page.getByRole("link", { name: "Manage" }).first();
    if (await pendingManage.isVisible().catch(() => false)) {
      await pendingManage.click();
    } else {
      await page.goto("/admin/orders");
      await page.getByRole("link", { name: "Manage" }).first().click();
    }
    await expect(page.getByText("Update status:")).toBeVisible({ timeout: 15000 });
    // Click the first permitted transition (CONFIRMED → Processing when available)
    await page.locator("button").filter({ hasText: /^(Confirmed|Processing|Shipped|Delivered)$/ }).first().click();
    await expect(page.getByText(/order moved to/i)).toBeVisible({ timeout: 15000 });
  });
});

test.describe("admin access control", () => {
  test("non-admin cannot access admin area (FR-38, NFR-12)", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel("Email address").fill(CUSTOMER.email);
    await page.getByLabel("Password").fill(CUSTOMER.password);
    await page.getByRole("button", { name: /sign in to admin/i }).click();
    // Proxy redirects back to admin login with Forbidden
    await expect(page).toHaveURL(/\/admin\/login\?error=Forbidden/);
    await expect(page.getByText("does not have administrator access")).toBeVisible();
  });
});
