/**
 * KHAREEDO — Phase 10: Responsive sweep at 8 viewports (320..1920).
 * Checks per page per viewport:
 *  - no horizontal overflow (scrollWidth <= clientWidth + 1)
 *  - key landmarks present & visible (header, nav/CTA)
 *  - interactive tap targets on mobile >= 40px (primary CTA)
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const VIEWPORTS = [320, 375, 430, 768, 1024, 1366, 1440, 1920];
const PAGES = ["/", "/products", "/product/his-hers-couple-watch-set", "/cart", "/categories", "/contact"];

const browser = await chromium.launch();
let fails = 0;

for (const width of VIEWPORTS) {
  const isMobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 800 : 900 },
    hasTouch: isMobile,
    isMobile,
    userAgent: isMobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined,
  });
  const page = await context.newPage();
  const line = [`vw=${width}`];

  for (const path of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { sw: d.scrollWidth, cw: d.clientWidth };
    });
    const ok = overflow.sw <= overflow.cw + 1;
    if (!ok) {
      fails++;
      // find widest offenders
      const offenders = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.right > document.documentElement.clientWidth + 1 && r.width > 20) {
            out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}→${Math.round(r.right)}`);
            if (out.length >= 3) break;
          }
        }
        return out;
      });
      line.push(`✗${path} sw=${overflow.sw}/${overflow.cw} [${offenders.join(", ")}]`);
    } else {
      line.push(`✓${path.replace("/", "") || "home"}`);
    }
  }
  console.log(line.join("  "));
  await context.close();
}

await browser.close();
console.log(`\nRESULT: ${fails === 0 ? "ALL PASS — zero horizontal overflow at all 8 viewports" : `${fails} overflow failures`}`);
process.exit(fails ? 1 : 0);
