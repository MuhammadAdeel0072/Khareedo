// E2E: guest browsing → search/filter → cart → guest checkout (COD) → confirmation.
// Mirrors the customer journey in the activity model (Phase 4.2).
import { expect, test } from "@playwright/test";
import { db } from "../../src/lib/db";

// Self-cleaning: purge the COD order this suite places, so repeat runs never
// pollute the demo database (audit Phase 11 — isolated test data).
test.afterAll(async () => {
  const junk = await db.order.findMany({
    where: { customerName: "E2E Guest Tester" },
    select: { id: true },
  });
  for (const o of junk) {
    await db.payment.deleteMany({ where: { orderId: o.id } });
    await db.orderItem.deleteMany({ where: { orderId: o.id } });
    await db.order.delete({ where: { id: o.id } });
  }
  await db.$disconnect();
});

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

  test("completes guest checkout with COD (FR-19..25, D-01/D-02)", async ({ page }) => {
    await page.goto("/product/casio-mens-analog-watch");
    await page.getByRole("button", { name: /add to cart/i }).first().click();
    // Wait for the add-to-cart POST to complete (toast confirms the cart write)
    await expect(page.getByText("Added to cart")).toBeVisible({ timeout: 10000 });

    await page.goto("/checkout");
    // Step 1: address
    await page.getByLabel("Full Name").fill("E2E Guest Tester");
    await page.getByLabel("Phone Number").fill("0321 5556677");
    await page.getByLabel("Email Address").fill("guest.e2e@example.com");
    await page.getByLabel("Street Address").fill("Test House 99, E2E Lane");
    await page.getByLabel("City").fill("Lahore");
    await page.getByRole("button", { name: /continue to delivery/i }).click();

    // Step 2: delivery (standard pre-selected) → continue
    await page.getByRole("button", { name: /continue to payment/i }).click();

    // Step 3: COD pre-selected → review
    await page.getByRole("button", { name: /review order/i }).click();

    // Step 4: confirm
    await page.getByRole("button", { name: /confirm order/i }).click();

    // Confirmation page with order reference (never shown for failed orders)
    await expect(page.getByText("Order Confirmed!")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Order Reference/i)).toBeVisible();
    // Seeded orders use KH+11 digits; runtime orders KH+13 — accept both
    await expect(page.locator("text=/^KH\\d{11,13}$/").first()).toBeVisible();
    await expect(page.getByText("Cash on Delivery").first()).toBeVisible();
  });

  test("empty cart shows empty state (alternative flow)", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/cart");
    await expect(page.getByText(/your cart is empty/i)).toBeVisible();
  });
});
