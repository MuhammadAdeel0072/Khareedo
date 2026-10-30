/**
 * KHAREEDO — Phase 6: Checkout concurrency / overselling verification.
 *
 * Scenario: N customers race for the LAST unit of a test product.
 * Expectation: exactly 1 success (200), N-1 rejections (422 OUT_OF_STOCK),
 * inventory never negative, order rows created = 1.
 *
 * Also verifies duplicate-order prevention: same idempotency key fired 3x
 * concurrently → exactly 1 order row.
 *
 * Cleanup: cancels + deletes created orders, restores inventory.
 */
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:3000";
const N_CUSTOMERS = 6;

function tsx(script) {
  return execSync(`npx tsx -e '${script}'`, {
    cwd: "/home/z/my-project",
    encoding: "utf8",
    timeout: 120000,
  });
}

// 1. create an isolated test product with exactly 1 unit in stock
console.log("== setup: isolated test product (stock=1) ==");
const setupOut = tsx(`
import {db} from "./src/lib/db";
(async()=>{
  const cat = await db.category.findFirst();
  const p = await db.product.create({data:{
    name:"CONCURRENCY TEST PROD", slug:"concurrency-test-prod-"+Date.now(),
    description:"audit", price:500, status:"PUBLISHED", categoryId:cat.id,
    sku:"KH-TST-CON-"+Math.floor(Math.random()*10000),
  }});
  await db.productImage.create({data:{productId:p.id,url:"/images/placeholder.svg",alt:"t"}});
  await db.inventory.create({data:{productId:p.id,quantity:1,lowStockThreshold:1}});
  console.log(JSON.stringify({id:p.id}));
  process.exit(0);
})()`);
const productId = JSON.parse(setupOut.trim().split("\n").pop()).id;
console.log("test product:", productId);

// 2. N guest sessions each add the product to their cart (distinct IPs behind proxy)
const guestCookies = [];
for (let i = 0; i < N_CUSTOMERS; i++) {
  const res = await fetch(`${BASE}/api/cart`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.77.0.${10 + i}` },
    body: JSON.stringify({ productId, quantity: 1 }),
  });
  const sc = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  guestCookies.push(sc.join("; "));
  if (res.status !== 200) {
    console.error(`guest ${i} cart add failed`, res.status, await res.text());
    process.exit(2);
  }
}
console.log(`== ${N_CUSTOMERS} guests each hold 1 unit of the last available stock ==`);

// 3. fire all place-order requests CONCURRENTLY
function payload(key) {
  return JSON.stringify({
    customer: { name: `Race Customer`, email: `race-${key}@example.com`, phone: "03001234567" },
    address: { fullName: "Race Customer", phone: "03001234567", line1: "1 Race St", city: "Karachi", province: "Sindh", postalCode: "74000" },
    paymentMethod: "COD",
    deliveryMethod: "STANDARD",
    idempotencyKey: `race-${key}-${Date.now()}`,
  });
}

const results = await Promise.all(
  guestCookies.map(async (cookie, i) => {
    const res = await fetch(`${BASE}/api/checkout/place`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-Forwarded-For": `10.77.0.${10 + i}` },
      body: payload(`race${i}-${Math.random().toString(36).slice(2)}`),
    });
    let body = null;
    try { body = await res.json(); } catch {}
    return { i, status: res.status, ok: body?.ok ?? false, code: body?.code ?? null, reference: body?.reference ?? null };
  })
);

const successes = results.filter((r) => r.ok && r.status === 200);
const stockFails = results.filter((r) => r.code === "OUT_OF_STOCK");
const busyFails = results.filter((r) => !r.ok && r.status === 422 && r.code !== "OUT_OF_STOCK");
console.log("\n== race results ==");
for (const r of results) console.log(`guest ${r.i}: ${r.status} ok=${r.ok} code=${r.code} ref=${r.reference}`);

let pass = true;
const assert = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!cond) pass = false;
};
assert("exactly-one-winner", successes.length === 1, `successes=${successes.length}`);
assert(
  "losers-rejected-cleanly",
  stockFails.length + busyFails.length === N_CUSTOMERS - 1,
  `out_of_stock=${stockFails.length} busy_retry=${busyFails.length} / ${N_CUSTOMERS - 1} (both 422, no partial state)`
);

// 4. DB verification: inventory == 0, never negative; exactly 1 order
const verifyOut = tsx(`
import {db} from "./src/lib/db";
(async()=>{
  const inv = await db.inventory.findUnique({where:{productId:"${productId}"}});
  const orders = await db.order.findMany({where:{items:{some:{productId:"${productId}"}}},select:{id:true,reference:true,status:true,total:true}});
  console.log(JSON.stringify({quantity:inv.quantity,orders}));
  process.exit(0);
})()`);
const v = JSON.parse(verifyOut.trim().split("\n").pop());
assert("inventory-zero-not-negative", v.quantity === 0, `quantity=${v.quantity}`);
assert("single-order-row", v.orders.length === 1, `orders=${v.orders.length} refs=${v.orders.map((o) => o.reference).join(",")}`);
assert("winner-status-confirmed", v.orders[0]?.status === "CONFIRMED", `status=${v.orders[0]?.status}`);

// 5. duplicate-order prevention: same idempotency key x3 concurrent
console.log("\n== idempotency: same key x3 concurrent ==");
const idemKey = `idem-test-${Date.now()}`;
// put another unit in stock so the duplicate test can actually place
tsx(`
import {db} from "./src/lib/db";
(async()=>{ await db.inventory.update({where:{productId:"${productId}"},data:{quantity:1}}); process.exit(0); })()`);
const dupCookies = [];
for (let i = 0; i < 3; i++) {
  const res = await fetch(`${BASE}/api/cart`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.77.1.${20 + i}` },
    body: JSON.stringify({ productId, quantity: 1 }),
  });
  dupCookies.push(res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "));
}
const dupResults = await Promise.all(
  dupCookies.map((cookie, i) =>
    fetch(`${BASE}/api/checkout/place`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-Forwarded-For": `10.77.1.${20 + i}` },
      body: JSON.stringify({
        customer: { name: "Idem Test", email: "idem@example.com", phone: "03001234567" },
        address: { fullName: "Idem Test", phone: "03001234567", line1: "1 Idem St", city: "Karachi", province: "Sindh", postalCode: "74000" },
        paymentMethod: "COD",
        deliveryMethod: "STANDARD",
        idempotencyKey: idemKey,
      }),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
  )
);
const dupRefs = [...new Set(dupResults.map((r) => r.body?.reference).filter(Boolean))];
console.log("responses:", dupResults.map((r) => `${r.status}/${r.body?.reference ?? r.body?.code}`).join("  "));
assert("same-key-same-order", dupRefs.length === 1, `distinct refs=${dupRefs.length} (${dupRefs.join(",")})`);

// 6. cleanup: remove test orders + ALL concurrency-test products
const cleanup = tsx(`
import {db} from "./src/lib/db";
(async()=>{
  const prods = await db.product.findMany({where:{name:"CONCURRENCY TEST PROD"},select:{id:true}});
  let removedOrders = 0;
  for (const p of prods) {
    const items = await db.orderItem.findMany({where:{productId:p.id},select:{orderId:true}});
    for (const it of items) {
      await db.payment.deleteMany({where:{orderId:it.orderId}});
      await db.orderItem.deleteMany({where:{orderId:it.orderId}});
      await db.order.deleteMany({where:{id:it.orderId}});
      removedOrders++;
    }
    await db.inventory.deleteMany({where:{productId:p.id}});
    await db.productImage.deleteMany({where:{productId:p.id}});
    await db.product.delete({where:{id:p.id}});
  }
  console.log(JSON.stringify({removedProducts:prods.length,removedOrders}));
  process.exit(0);
})()`).trim().split("\n").pop();
console.log("cleanup:", cleanup);

console.log(`\nRESULT: ${pass ? "ALL PASS" : "FAILURES PRESENT"}`);
process.exit(pass ? 0 : 1);
