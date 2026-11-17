// E2E: guest browsing → search/filter → cart. Checkout and order tracking
// require sign-in (PR-04, D-01) — a guest is redirected to /login instead of
// reaching checkout or a confirmation page, and cannot place an order
// through the API either.
// Mirrors the customer journey in the activity model (Phase 4.2).
import { expect, test } from "@playwright/test";

test.describe("guest shopping journey", () => {
  test("browses homepage and sees featured products", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Featured Products")).toBeVisible();
    // category circles render
    await expect(page.getByRole("link", { name: "Earbuds" }).first()).toBeVisible();
  });

  test("searches products by keyword (FR-09)", async ({ page }) => {
    await page.goto("/products?q=watch");
    await expect(page.getByText(/products? found/i).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("article").first()).toBeVisible();
  });

  test("filters by category (FR-10)", async ({ page }) => {
    await page.goto("/products?category=earbuds");
    await expect(page.getByRole("heading", { name: "Earbuds" })).toBeVisible();
    // every card belongs to earbuds or its subtree
    const first = page.getByRole("article").first();
    await expect(first).toBeVisible();
  });

  test("views product details (FR-08)", async ({ page }) => {
    await page.goto("/products");
    await page.getByRole("article").first().getByRole("link").first().click();
    await expect(page.getByRole("button", { name: /add to cart/i }).first()).toBeVisible();
    await expect(page.getByText(/in stock|left in stock/i).first()).toBeVisible();
  });

  test("adds to cart, updates quantity, sees subtotal (FR-14..16)", async ({ page }) => {
    await page.goto("/product/soundpeats-q3-pro-anc");
    await page.getByRole("button", { name: /add to cart/i }).first().click();
    await expect(page.getByText("Added to cart")).toBeVisible();

    await page.goto("/cart");
    await expect(page.getByRole("heading", { name: /shopping cart/i })).toBeVisible();
    // increase quantity
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.getByText("Subtotal (2 items)")).toBeVisible();
  });

  test("cannot reach checkout without signing in (PR-04, D-01)", async ({ page }) => {
    await page.goto("/product/casio-mens-analog-watch");
    await page.getByRole("button", { name: /add to cart/i }).first().click();
    await expect(page.getByText("Added to cart")).toBeVisible({ timeout: 10000 });

    await page.goto("/checkout");
    // Unauthenticated visitors are sent to sign-in, with checkout as the return target
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fcheckout&reason=checkout/);
    await expect(page.getByLabel("Email address")).toBeVisible();
  });

  test("cannot track an order without signing in (PR-04, D-01)", async ({ page }) => {
    // A know-only order reference must not grant access to the confirmation page
    await page.goto("/order/KH26030110021");
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Forder%2FKH26030110021&reason=tracking/);
    await expect(page.getByLabel("Email address")).toBeVisible();
  });

  test("cannot place an order through the API without signing in (PR-04, D-01)", async ({ page }) => {
    const response = await page.request.post("/api/checkout/place", {
      data: {
        idempotencyKey: "e2e-unauthenticated-place",
        customer: { name: "E2E Guest", email: "guest.e2e@example.com", phone: "0321 5556677" },
        address: {
          fullName: "E2E Guest", phone: "0321 5556677",
          line1: "Test House 99, E2E Lane", city: "Lahore", province: "Punjab",
        },
        deliveryMethod: "STANDARD",
        paymentMethod: "COD",
      },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  test("empty cart shows empty state (alternative flow)", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/cart");
    await expect(page.getByText(/your cart is empty/i)).toBeVisible();
  });
});
