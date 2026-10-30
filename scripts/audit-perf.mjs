/**
 * KHAREEDO — Phase 8: Core Web Vitals measurement (production server).
 * Measures LCP / CLS / TTFB / FCP / DOMContentLoaded for key routes,
 * desktop + mobile profiles. Prints a machine-readable table.
 */
import { chromium, devices } from "playwright";

const BASE = "http://localhost:3000";
const RUNS = 3;

const routes = [
  { name: "home", path: "/" },
  { name: "products", path: "/products" },
  { name: "pdp", path: null }, // filled with a real slug
  { name: "cart", path: "/cart" },
  { name: "login", path: "/login" },
  { name: "categories", path: "/categories" },
];

async function getSlug() {
  const res = await fetch(`${BASE}/products`);
  const html = await res.text();
  const m = html.match(/\/product\/([a-z0-9-]+)/);
  return m ? m[1] : null;
}

async function measure(page, path) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const nav = performance.getEntriesByType("navigation")[0];
        let lcp = 0, cls = 0, fcp = 0;
        new PerformanceObserver((l) => {
          const es = l.getEntries();
          if (es.length) lcp = es[es.length - 1].startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value;
        }).observe({ type: "layout-shift", buffered: true });
        new PerformanceObserver((l) => {
          const es = l.getEntries();
          if (es.length) fcp = es[es.length - 1].startTime;
        }).observe({ type: "paint", buffered: true });
        setTimeout(() => {
          resolve({
            ttfb: Math.round(nav.responseStart),
            dcl: Math.round(nav.domContentLoadedEventEnd),
            load: Math.round(nav.loadEventEnd || performance.now()),
            lcp: Math.round(lcp),
            fcp: Math.round(fcp),
            cls: Number(cls.toFixed(4)),
          });
        }, 3000);
      })
  );
}

async function runProfile(browser, label, device) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const rows = [];
  for (const r of routes) {
    const path = r.path ?? `/product/${slug}`;
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 60000 });
      const m = await measure(page, path);
      samples.push(m);
      await page.waitForTimeout(400);
    }
    // median per metric
    const med = (k) => {
      const arr = samples.map((s) => s[k]).sort((a, b) => a - b);
      return arr[Math.floor(arr.length / 2)];
    };
    rows.push({
      profile: label,
      route: r.name,
      ttfb: med("ttfb"),
      fcp: med("fcp"),
      lcp: med("lcp"),
      cls: samples[Math.floor(samples.length / 2)]["cls"],
      dcl: med("dcl"),
      load: med("load"),
    });
    console.log(`${label}  ${r.name.padEnd(11)} TTFB=${med("ttfb")}ms  FCP=${med("fcp")}ms  LCP=${med("lcp")}ms  CLS=${rows[rows.length - 1].cls}  DCL=${med("dcl")}ms  Load=${med("load")}ms`);
  }
  await context.close();
  return rows;
}

const slug = await getSlug();
if (!slug) {
  console.error("no product slug found");
  process.exit(2);
}
console.log(`# Phase 8 perf @ ${BASE} (production build) — ${RUNS} runs/route, median — slug=${slug}`);

const browser = await chromium.launch();
const all = [];
all.push(...(await runProfile(browser, "desktop", { viewport: { width: 1366, height: 768 } })));
all.push(...(await runProfile(browser, "mobile", { ...devices["Pixel 7"] })));

console.log("\n# Verdicts (p75-proxy = median of 3):");
for (const r of all) {
  const lcpOk = r.lcp <= 2500 ? "OK" : "OVER";
  const clsOk = r.cls <= 0.1 ? "OK" : "OVER";
  console.log(`${r.profile}/${r.route}: LCP ${r.lcp}ms [${lcpOk}] CLS ${r.cls} [${clsOk}]`);
}
await browser.close();
