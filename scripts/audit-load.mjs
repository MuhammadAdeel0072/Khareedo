/**
 * KHAREEDO — Phase 9: Controlled scalability load test (LOCAL staging only).
 * Scenarios at 10 / 50 / 100 concurrent virtual users:
 *   A. browse:    GET / + /products + /categories
 *   B. search:    GET /products?q=<term>
 *   C. cart ops:  POST /api/cart (add) + GET quote — distinct cookies per VU
 * Metrics: requests, RPS, p50/p95 latency, error rate.
 * NOTE: run against localhost prod build; numbers are relative, not internet-scale.
 */
import { execSync } from "node:child_process";

const BASE = "http://localhost:3000";
const LEVELS = [10, 50, 100];
const DURATION_MS = 15_000;

let productId;
try {
  const out = execSync(
    `npx tsx -e 'import {db} from "./src/lib/db"; db.product.findFirst({select:{id:true}}).then(r=>{console.log(r.id);process.exit(0)})'`,
    { cwd: "/home/z/my-project", encoding: "utf8", timeout: 90000 }
  );
  productId = out.trim().split("\n").pop();
} catch {
  console.error("no product");
  process.exit(2);
}

const lat = [];
let errors = 0;
let count = 0;
let stop = false;

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

async function timed(fn) {
  const t0 = performance.now();
  try {
    const res = await fn();
    if (!res.ok && ![307, 404, 422].includes(res.status)) errors++;
    count++;
    lat.push(performance.now() - t0);
  } catch {
    errors++;
    count++;
    lat.push(performance.now() - t0);
  }
}

async function vuBrowse() {
  const paths = ["/", "/products", "/categories"];
  let i = 0;
  while (!stop) {
    const p = paths[i++ % paths.length];
    await timed(() => fetch(`${BASE}${p}`));
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function vuSearch() {
  const terms = ["watch", "bag", "shoes", "phone", "lamp"];
  let i = 0;
  while (!stop) {
    const q = terms[i++ % terms.length];
    await timed(() => fetch(`${BASE}/products?q=${q}`));
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function vuCart(idx) {
  while (!stop) {
    const res = await fetch(`${BASE}/api/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.90.${idx}.1` },
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const sc = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    await timed(() =>
      fetch(`${BASE}/api/checkout/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sc, "X-Forwarded-For": `10.90.${idx}.1` },
        body: JSON.stringify({ deliveryMethod: "STANDARD" }),
      })
    );
    await timed(() =>
      fetch(`${BASE}/api/cart`, {
        method: "DELETE",
        headers: { Cookie: sc, "X-Forwarded-For": `10.90.${idx}.1` },
      })
    );
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function runLevel(n, workers) {
  lat.length = 0;
  errors = 0;
  count = 0;
  stop = false;
  const vus = [];
  for (let i = 0; i < n; i++) vus.push(workers(i));
  setTimeout(() => (stop = true), DURATION_MS);
  await Promise.all(vus);
  await new Promise((r) => setTimeout(r, 300));
  console.log(
    `reqs=${count}  RPS=${((count / DURATION_MS) * 1000).toFixed(1)}  p50=${pct(lat, 50)}ms  p95=${pct(lat, 95)}ms  p99=${pct(lat, 99)}ms  errors=${errors} (${((errors / Math.max(1, count)) * 100).toFixed(2)}%)`
  );
}

console.log(`# Phase 9 load test @ ${BASE} — ${DURATION_MS / 1000}s per level, mixed scenarios\n`);

console.log("-- Scenario A: browse (/, /products, /categories) --");
for (const n of LEVELS) await runLevel(n, (i) => vuBrowse());

console.log("\n-- Scenario B: search /products?q= --");
for (const n of LEVELS) await runLevel(n, (i) => vuSearch());

console.log("\n-- Scenario C: cart add + quote + clear (write path) --");
for (const n of LEVELS) await runLevel(n, (i) => vuCart(i));
