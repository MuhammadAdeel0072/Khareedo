// Shared E2E helpers: seeded accounts, customer login, and the MFA-aware
// admin login (PR-10). The admin flow needs care:
//
// - Admin MFA is enforced and bound to ONE session id
//   (AdminMfa.lastVerifiedSessionId): only the most recently verified
//   session is MFA-verified. Two projects/workers therefore cannot hold
//   verified admin sessions at the same time, so admin tests share ONE
//   MFA-verified session per run via a storage-state file (see
//   ensureAdminSession). Run admin specs with sequential projects
//   (the default on a 1-worker runner); on multi-worker CI the admin
//   describes must not run concurrently.
// - MFA verify is rate-limited (5/15min per admin), so the stored session
//   is reused across runs when it is still valid (ensureAdminSession checks
//   by loading /admin first). A fresh password + TOTP login happens only
//   when the stored session is missing or no longer verified. If the
//   disposable database is re-created, delete /tmp/e2e-admin-mfa-key.txt
//   and /tmp/e2e-admin-storage-state.json and the next run re-enrolls.
// - The TOTP secret belongs to the disposable test database only.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Browser, type Locator, type Page } from "@playwright/test";

/**
 * The PDP renders TWO purchase panels: an in-flow panel (`hidden lg:block`)
 * and a mobile sticky bottom bar (`lg:hidden`, rendered only once the
 * product section has scrolled out of view). Desktop-only text such as
 * "Select variant: Small" is display:none on mobile, and the sticky bar's
 * buttons do not exist until the page is scrolled. PDP interactions
 * therefore go through the VISIBLE button: scroll first (harmless on
 * desktop), then pick the visible match.
 */
export async function scrollForStickyBar(page: Page) {
  // Scroll to the very bottom: the sticky bar appears only when the
  // [data-product-main] section stops intersecting the viewport at all
  // (IntersectionObserver, threshold 0), and the section is far taller
  // than one viewport on mobile — a fixed 800px scroll leaves part of it
  // visible and the bar stays hidden.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}

export function visibleButton(page: Page, name: RegExp | string): Locator {
  return page.locator("button:visible", { hasText: name }).first();
}

/**
 * Click the PDP's own Add to Cart. On mobile this MUST target the sticky
 * bar's button: the related-products cards' buttons are visible sooner
 * (the bar only appears once the product section scrolls out of view),
 * so a plain "first visible Add to Cart" click races and adds the wrong
 * product. On desktop the in-flow panel's button is first in DOM order.
 */
export async function pdpAddToCart(page: Page) {
  await scrollForStickyBar(page);
  const width = page.viewportSize()?.width ?? 0;
  if (width < 1024) {
    const bar = page.locator("div.fixed.inset-x-0.bottom-0");
    await expect(bar.getByRole("button", { name: /add to cart/i })).toBeVisible({ timeout: 10000 });
    await bar.getByRole("button", { name: /add to cart/i }).click();
  } else {
    await page.getByRole("button", { name: /add to cart/i }).first().click();
  }
}

/**
 * Sonner toasts pause their auto-dismiss timer while hovered. On mobile
 * the toast sits on top of the sticky bar's Add to Cart button, and
 * Playwright's mouse rests there after the click — so the toast never
 * dismisses and every later click is intercepted. Move the mouse away
 * and wait for the toasts to clear before clicking again.
 */
export async function dismissToasts(page: Page) {
  await page.mouse.move(5, 5);
  await expect(page.locator("li[data-sonner-toast]")).toHaveCount(0, { timeout: 10000 });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `E2E requires ${name} to be set (seed with SEED_ADMIN_PASSWORD / SEED_CUSTOMER_PASSWORD first — see docs/SEEDING.md).`,
    );
  }
  return value;
}

export const CUSTOMER = { email: "ali.hassan@example.com", password: requiredEnv("SEED_CUSTOMER_PASSWORD") };
export const SARA = { email: "sara.khan@example.com", password: requiredEnv("SEED_CUSTOMER_PASSWORD") };
export const ADMIN = { email: "admin@khareedo.pk", password: requiredEnv("SEED_ADMIN_PASSWORD") };

/** Customer sign-in with a post-login wait (session cookie must settle before navigation). */
export async function customerLogin(page: Page, creds = CUSTOMER) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/account", { timeout: 15000 });
  await page.waitForLoadState("load");
  await expect(page.getByRole("heading", { name: "My Account", level: 1 })).toBeVisible({ timeout: 15000 });
}

/** TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s step) for the seeded admin's
 * enrolled authenticator. Implemented here so the suite can complete the
 * MFA verify step without an external authenticator app. */
export function totpCode(base32Secret: string, offsetSteps = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = base32Secret.replace(/=+$/, "").toUpperCase();
  const bits: number[] = [];
  for (const ch of clean) {
    const value = alphabet.indexOf(ch);
    if (value < 0) throw new Error("Invalid base32 in MFA secret");
    for (let i = 4; i >= 0; i--) bits.push((value >> i) & 1);
  }
  const bytes = Buffer.from(
    bits.reduce<number[][]>((acc, bit, i) => {
      const byteIndex = Math.floor(i / 8);
      acc[byteIndex] = acc[byteIndex] ?? [];
      acc[byteIndex].push(bit);
      return acc;
    }, []).map((b) => parseInt(b.join("").padEnd(8, "0"), 2)),
  );
  const counter = Math.floor(Date.now() / 30_000) + offsetSteps;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", bytes).update(counterBuf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[off] & 0x7f) << 24) |
    ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) |
    (hmac[off + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

export const MFA_KEY_FILE = "/tmp/e2e-admin-mfa-key.txt";
export const ADMIN_STORAGE_STATE = "/tmp/e2e-admin-storage-state.json";

export function readMfaKey(): string | null {
  if (process.env.E2E_ADMIN_MFA_KEY) return process.env.E2E_ADMIN_MFA_KEY;
  return existsSync(MFA_KEY_FILE) ? readFileSync(MFA_KEY_FILE, "utf8").trim() : null;
}
function saveMfaKey(key: string) {
  writeFileSync(MFA_KEY_FILE, key);
}

/** Admin sign-in with a post-login wait (waits for the dashboard to render). */
export async function adminLogin(page: Page) {
  await page.goto("/admin/login");
  // A stored session may already be signed in (but not MFA-verified): the
  // login page then redirects straight to /admin/mfa/verify with no form
  // to fill. Only fill the form when it actually renders.
  const formVisible = await page
    .getByLabel("Email address")
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (formVisible) {
    await page.getByLabel("Email address").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: /sign in to admin/i }).click();
    // Admin MFA (PR-10) is enforced: a password-only session lands on the
    // MFA setup page (not yet enrolled) or the verify page (enrolled).
    await page.waitForURL((url) => url.pathname !== "/admin/login", { timeout: 15000 });
  }
  const url = page.url();
  if (url.includes("/admin/mfa/verify")) {
    await verifyMfa(page);
  } else if (url.includes("/admin/mfa/setup")) {
    await enrollAndVerifyMfa(page);
  }
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });
}

/** Complete the MFA verify page with a TOTP code from the enrolled secret. */
async function verifyMfa(page: Page) {
  const key = readMfaKey();
  if (!key) throw new Error("Admin MFA is enabled but no TOTP secret is stored (see MFA_KEY_FILE).");
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByLabel(/authenticator code/i).fill(totpCode(key, attempt));
    await page.getByRole("button", { name: /verify/i }).click();
    // Wait for the navigation AWAY from the verify page: the predicate must
    // NOT match the current URL, or a success would be misread as a failure
    // and the code submitted twice (a second verify consumes another
    // rate-limit slot and can 429).
    const landed = await page
      .waitForURL((u) => u.pathname === "/admin", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (landed) return;
    // Still on the verify page: read the form's error (if any) before
    // retrying with the adjacent step's code.
    const error = await page.locator("form p").first().textContent().catch(() => null);
    if (error?.includes("Too many requests")) {
      throw new Error(`MFA verify rate-limited: ${error}`);
    }
  }
  throw new Error("MFA verify did not reach the dashboard after 2 attempts.");
}

/** First-time enrollment (setup page) via the MFA API, then verify. */
async function enrollAndVerifyMfa(page: Page) {
  let key = readMfaKey();
  if (!key) {
    const res = await page.request.post("/api/admin/mfa/setup", { data: {} });
    if (res.status() === 403) {
      // Another worker enrolled first: wait for its shared secret, then verify.
      for (let i = 0; i < 30 && !key; i++) {
        await page.waitForTimeout(1000);
        key = readMfaKey();
      }
      if (!key) throw new Error("MFA already enabled but the shared TOTP secret never appeared.");
    } else {
      if (!res.ok()) throw new Error(`MFA setup failed with ${res.status()}`);
      const data = (await res.json()) as { manualKey?: string };
      if (!data.manualKey) throw new Error("MFA setup returned no manual key.");
      key = data.manualKey;
      saveMfaKey(key);
      const activate = await page.request.post("/api/admin/mfa/activate", {
        data: { code: totpCode(key) },
      });
      if (!activate.ok()) throw new Error(`MFA activate failed with ${activate.status()}`);
    }
  }
  await page.goto("/admin/mfa/verify");
  await verifyMfa(page);
}

/**
 * Ensure the shared admin storage state exists and is MFA-verified.
 * Call from a `test.beforeAll` in admin describes; pair with
 * `test.use({ storageState: ADMIN_STORAGE_STATE })`. Reuses a stored
 * session when it still reaches the dashboard, so repeat runs do not
 * burn the MFA verify rate limit; otherwise signs in (enrolling MFA on
 * first use) and saves the state.
 */
export async function ensureAdminSession(browser: Browser) {
  const context = await browser.newContext({
    storageState: existsSync(ADMIN_STORAGE_STATE) ? ADMIN_STORAGE_STATE : undefined,
  });
  const page = await context.newPage();
  await page.goto("/admin");
  const sessionValid = await page
    .getByRole("heading", { name: "Dashboard" })
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!sessionValid) {
    await adminLogin(page);
    await context.storageState({ path: ADMIN_STORAGE_STATE });
  }
  await context.close();
}
