import { chromium } from "playwright";

// Task 1 verification: payment-method default selection, single-click switching,
// step round-trip persistence.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on("pageerror", (err) => console.log("PAGEERROR:", err.message));

const log = (...a) => console.log(...a);

// Login as customer
await page.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
await page.getByLabel(/email/i).first().fill("ali.hassan@example.com");
await page.getByLabel(/password/i).first().fill("Customer@123");
await Promise.all([
  page.waitForLoadState("networkidle").catch(() => {}),
  page.getByRole("button", { name: /sign in/i }).click(),
]);
await page.waitForTimeout(2500);
log("login url:", page.url());

// Add first product to cart from products page
await page.goto("http://localhost:3000/products", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const addBtn = page.getByRole("button", { name: /add to cart/i }).first();
if (await addBtn.count()) {
  await addBtn.click();
  await page.waitForTimeout(1200);
  log("added product to cart");
} else {
  // product page fallback
  await page.goto("http://localhost:3000/product/casio-mens-analog-watch", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /add to cart/i }).first().click();
  await page.waitForTimeout(1200);
  log("added via product page");
}

// Go to checkout
await page.goto("http://localhost:3000/checkout", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
log("checkout url:", page.url());

// Advance to payment step (step 3): fill address form if present
const continueBtn = page.getByRole("button", { name: /continue to (delivery|payment)/i }).first();
if (await continueBtn.count()) {
  await continueBtn.click().catch(() => {});
  await page.waitForTimeout(800);
}
const continueBtn2 = page.getByRole("button", { name: /continue to payment/i }).first();
if (await continueBtn2.count()) {
  await continueBtn2.click().catch(() => {});
  await page.waitForTimeout(800);
}

// ─── Check payment step state ───
await page.waitForTimeout(500);
const paymentSection = await page.getByText("Payment Method", { exact: false }).first().isVisible().catch(() => false);
log("payment section visible:", paymentSection);

// Which radio is checked?
const checked = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role="radiogroup"] button[role="radio"]')];
  return items.map((b) => ({ value: b.getAttribute("value"), state: b.getAttribute("data-state") }));
});
log("radios:", JSON.stringify(checked));

const codChecked = checked.find((r) => r.value === "COD")?.state === "checked";
log("EVIDENCE 1 — COD auto-selected on entering payment step:", codChecked ? "PASS" : "FAIL");

await page.screenshot({ path: "/tmp/render/checkout-payment-step.png", fullPage: false });

// ─── Single click switch: click the BANK_TRANSFER card label ONCE ───
const bankLabel = page.locator('label[for="payment-BANK_TRANSFER"]');
if (await bankLabel.count()) {
  await bankLabel.click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="radiogroup"] button[role="radio"]')];
    return items.map((b) => ({ value: b.getAttribute("value"), state: b.getAttribute("data-state") }));
  });
  const bankNow = after.find((r) => r.value === "BANK_TRANSFER")?.state === "checked";
  const codOff = after.find((r) => r.value === "COD")?.state !== "checked";
  log("EVIDENCE 2 — one click switches to Bank Transfer:", bankNow && codOff ? "PASS" : "FAIL", JSON.stringify(after));

  // ─── Step round-trip: back to delivery (step 2) then forward again ───
  await page.getByRole("button", { name: /← Back/i }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: /continue to payment/i }).first().click();
  await page.waitForTimeout(900);
  const persisted = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="radiogroup"] button[role="radio"]')];
    return items.map((b) => ({ value: b.getAttribute("value"), state: b.getAttribute("data-state") }));
  });
  const kept = persisted.find((r) => r.value === "BANK_TRANSFER")?.state === "checked";
  log("EVIDENCE 3 — selection persists across step round-trip:", kept ? "PASS" : "FAIL", JSON.stringify(persisted));
  await page.screenshot({ path: "/tmp/render/checkout-payment-persisted.png" });
} else {
  log("BANK_TRANSFER option not present — check config.codEnabled/sandbox settings");
}

await browser.close();
log("DONE");
