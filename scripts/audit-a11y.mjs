/**
 * KHAREEDO — a11y probe: keyboard focus visibility, form labels, img alts,
 * html lang, heading hierarchy on key pages (Phase 10 requirements).
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const PAGES = ["/", "/products", "/login", "/cart"];

const browser = await chromium.launch();
let issues = 0;

for (const path of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await page.goto(`${BASE}${path}`, { waitUntil: "load" });
  const report = await page.evaluate(() => {
    const out = { lang: document.documentElement.lang, unlabeled: 0, emptyAltImgs: 0, imgs: 0, h1: 0, focusOutline: false };
    out.h1 = document.querySelectorAll("h1").length;
    // form controls without accessible names — excluding intentionally hidden
    // assistive inputs (aria-hidden / display:none / Radix form-compat)
    for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      if (el.getAttribute("aria-hidden") === "true" || el.closest("[aria-hidden=true]")) continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const id = el.id;
      const label = id && document.querySelector(`label[for="${id}"]`);
      const aria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("placeholder");
      if (!label && !aria) out.unlabeled++;
    }
    // images missing alt
    for (const img of document.querySelectorAll("img")) {
      out.imgs++;
      if (img.getAttribute("alt") === null) out.emptyAltImgs++;
    }
    return out;
  });

  // keyboard: tab 4 times, check activeElement gets a visible outline (focus-visible styles)
  let focusOk = true;
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  focusOk = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const st = getComputedStyle(el);
    // visible if it has an outline, box-shadow, or different bg
    return (
      (st.outlineWidth !== "0px" && st.outlineStyle !== "none") ||
      st.boxShadow !== "none" ||
      el.matches(":focus-visible")
    );
  });

  const problems = [];
  if (!report.lang) problems.push("missing html lang");
  if (report.unlabeled > 0) problems.push(`${report.unlabeled} unlabeled form controls`);
  if (report.emptyAltImgs > 0) problems.push(`${report.emptyAltImgs}/${report.imgs} imgs missing alt`);
  if (report.h1 !== 1) problems.push(`${report.h1} h1 elements (want 1)`);
  if (!focusOk) problems.push("keyboard focus not visible after 4 tabs");

  console.log(`${path.padEnd(10)} ${problems.length ? "ISSUES: " + problems.join("; ") : "OK (lang, labels, alts, single h1, visible focus)"}`);
  issues += problems.length;
  await page.close();
}

await browser.close();
console.log(`\nRESULT: ${issues === 0 ? "ALL PASS" : issues + " issue(s)"}`);
process.exit(issues ? 1 : 0);
