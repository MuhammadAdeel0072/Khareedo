import { chromium } from "playwright";

// Core Web Vitals probe: LCP, CLS, INP-approx (event timing), TTFB.
// Usage: node scripts/cwv-probe.mjs [runsPerRoute]
const RUNS = Number(process.argv[2] ?? 3);
const BASE = "http://localhost:3000";
const ROUTES = ["/", "/products", "/product/soundpeats-q3-pro-anc", "/categories"];

const browser = await chromium.launch();

async function measure(path) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__cwv = { lcp: 0, cls: 0, inp: 0, ttfb: 0 };
    try {
      new PerformanceObserver((l) => {
        const es = l.getEntries();
        if (es.length) window.__cwv.lcp = es[es.length - 1].startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cwv.cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__cwv.inp = Math.max(window.__cwv.inp, e.duration);
      }).observe({ type: "event", buffered: true, eventCatalog: ["click", "keydown"] });
    } catch {}
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) window.__cwv.ttfb = nav.responseStart;
  });
  await page.goto(BASE + path, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2500);
  const v = await page.evaluate(() => window.__cwv);
  await context.close();
  return v;
}

const out = {};
for (const r of ROUTES) {
  out[r] = [];
  for (let i = 0; i < RUNS; i++) {
    const v = await measure(r);
    out[r].push(v);
    process.stdout.write(`${r} run${i + 1}: LCP=${Math.round(v.lcp)}ms CLS=${v.cls.toFixed(4)} INP≈${Math.round(v.inp)}ms TTFB=${Math.round(v.ttfb)}ms\n`);
  }
}

// summary: medians
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
console.log("\n=== MEDIANS ===");
for (const [r, vs] of Object.entries(out)) {
  console.log(`${r}  LCP=${Math.round(med(vs.map((v) => v.lcp)))}ms  CLS=${med(vs.map((v) => v.cls)).toFixed(4)}  INP≈${Math.round(med(vs.map((v) => v.inp)))}ms  TTFB=${Math.round(med(vs.map((v) => v.ttfb)))}ms`);
}
await browser.close();
