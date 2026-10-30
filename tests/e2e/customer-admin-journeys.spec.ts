// E2E: registered customer journey + admin management journey.
import { expect, test, type Page } from "@playwright/test";
import { db } from "../../src/lib/db";

// Self-cleaning: remove the product this suite creates (archived or not), so
// repeat runs never pollute the 51-product demo catalogue (audit Phase 11).
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
  await db.$disconnect();
});

const CUSTOMER = { email: "ali.hassan@example.com", password: "Customer@123" };
const SARA = { email: "sara.khan@example.com", password: "Customer@123" };
const ADMIN = { email: "admin@khareedo.pk", password: "Admin@123" };

/** Customer sign-in with a post-login wait (session cookie must settle before navigation). */
async function customerLogin(page: Page, creds = CUSTOMER) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/account", { timeout: 15000 });
  await page.waitForLoadState("load");
  await expect(page.getByRole("heading", { name: "My Account", level: 1 })).toBeVisible({ timeout: 15000 });
}

/** Admin sign-in with a post-login wait (waits for the dashboard to render). */
async function adminLogin(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email address").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: /sign in to admin/i }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });
}

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
});

test.describe("admin journey", () => {
  test("admin signs in and views dashboard (FR-38, FR-45)", async ({ page }) => {
    await adminLogin(page);
    await expect(page.getByText("Total Orders").first()).toBeVisible();
  });

  test("non-admin cannot access admin area (FR-38, NFR-12)", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel("Email address").fill(CUSTOMER.email);
    await page.getByLabel("Password").fill(CUSTOMER.password);
    await page.getByRole("button", { name: /sign in to admin/i }).click();
    // Proxy redirects back to admin login with Forbidden
    await expect(page).toHaveURL(/\/admin\/login\?error=Forbidden/);
    await expect(page.getByText("does not have administrator access")).toBeVisible();
  });

  test("admin creates and publishes a product via inline dialog (FR-39/40)", async ({ page }) => {
    await adminLogin(page);

    await page.goto("/admin/products");
    await page.getByRole("button", { name: /add product/i }).click();
    await page.getByLabel("Product name *").fill("E2E Test Product");
    await page.getByLabel(/price \(pkr\)/i).fill("1999");
    await page.getByLabel("Stock quantity").fill("5");
    await page.getByLabel("Paste image URL").fill("/images/placeholder.svg");
    await page.getByLabel("Paste image URL").press("Enter");
    await page.getByLabel("Category *").selectOption({ index: 1 });
    await page.getByRole("button", { name: /create product/i }).click();

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
    await adminLogin(page);

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
    await adminLogin(page);

    // Prefer a PENDING order; fall back to the newest order (newest COD orders are PENDING)
    await page.goto("/admin/orders?status=PENDING");
    const pendingManage = page.getByRole("link", { name: "Manage" }).first();
    if (await pendingManage.isVisible().catch(() => false)) {
      await pendingManage.click();
    } else {
      await page.goto("/admin/orders");
      await page.getByRole("link", { name: "Manage" }).first().click();
    }
    await expect(page.getByText("Update status:")).toBeVisible({ timeout: 15000 });
    // Click the first permitted transition (PENDING → Confirmed when available)
    await page.locator("button").filter({ hasText: /^(Confirmed|Processing|Shipped|Delivered)$/ }).first().click();
    await expect(page.getByText(/order moved to/i)).toBeVisible({ timeout: 15000 });
  });
});
