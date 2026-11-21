// Postgres-only regression coverage (perf audit follow-up).
// Pins three Postgres-only behaviours the disposable SQLite harness
// CANNOT catch, each of which was a real regression on this branch:
//
//   V-1   cart stock joins used bare `IS` for a column comparison
//         (cart.service.ts) — Postgres 42601 syntax error, so the cart
//         page/badge/quote threw on Postgres while SQLite passed.
//   42P18 adminListInventory tested a bound parameter with bare
//         `$n IS NULL` (inventory.service.ts) — Postgres cannot infer
//         the parameter type, so EVERY admin inventory list call
//         failed on Postgres while SQLite passed.
//   R4    statement_timeout=30s (src/lib/db.ts) — without it one hung
//         query can hold a pool connection indefinitely.
//
// Each describe has TWO kinds of test: (a) the real service call, which
// FAILS on the pre-fix code and PASSES on the fixed code, and (b) a
// negative probe executing the exact PRE-FIX SQL shape, which proves
// the dialect fact independently of the service (the old text cannot
// even parse on Postgres). Fail-on-old-code was verified by running
// this file against a git worktree at committed HEAD de23fe5 (scratch
// copy, main tree untouched): 4 failed / 4 passed there —
// getCartDetailsForCart and addToCart+getCartCount failed with 42601,
// SHOW statement_timeout returned '0', and pg_sleep(35) ran the full
// 35s uncancelled. One honest exception: the adminListInventory service
// test PASSES at HEAD, because HEAD still has the old Prisma
// implementation — the 42P18 bug was introduced by the Stage 2 raw-SQL
// rewrite and fixed by the CAST in the same uncommitted tree. Its
// fail-on-broken-code evidence is the Stage 5/6 temp probe (3/3 failed
// pre-CAST → 3/3 passed post-CAST, audit-stage5-6-tests-load.md §2);
// the negative probe below pins the dialect fact permanently.
//
// Runs ONLY against a disposable local PostgreSQL — never production.
// Run: PG_VERIFY_URL='postgresql://pgverify:pgverify-disposable-only@127.0.0.1:55434/khareedo_pg_concurrency' \
//        npx vitest run --config tests/postgres/vitest.pg.config.ts tests/postgres/pg-regression.test.ts
// or: npm run test:pg   (same config; PG_VERIFY_URL must point at the
// disposable DB — the config default is the disposable concurrency DB
// on localhost, and the guard below refuses anything else).
// NOT included in `npm test` or `npm run test:db` (separate config).
// NOTE: the statement-timeout enforcement test sleeps ~30s by design
// (it proves the server cancels at 30s, not at completion); it is the
// only slow test in this file.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db } from "@/lib/db";
import { getCartDetailsForCart, addToCart, getCartCount } from "@/services/cart.service";
import { adminListInventory } from "@/services/inventory.service";

// getCartCount (:334) and addToCart -> getCartItemCount (:365) resolve
// the visitor through the session/cookies, which do not exist in this
// node-env suite: mock both so the real service code runs against the
// disposable DB. The mocks are file-scoped; nothing else in this file
// touches auth or cookies.
const mockSessionUser = vi.hoisted(() => ({ id: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (_name: string) => undefined,
    set: () => undefined,
  }),
}));
vi.mock("@/lib/auth-guard", () => ({
  getSessionUser: async () =>
    mockSessionUser.id ? { id: mockSessionUser.id } : null,
}));

const PG_URL = process.env.PG_VERIFY_URL ?? "";
let n = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

async function makeUser(email: string) {
  return db.user.create({ data: { id: uid("pgr-u"), email, role: "CUSTOMER" } });
}

async function makeProductWithVariant(opts: {
  price: number;
  stock: number;
  variantStock: number;
  variantPriceOverride: number | null;
}) {
  const cat = await db.category.create({
    data: { id: uid("pgr-cat"), name: "PGR Cat", slug: uid("pgr-cat") },
  });
  const product = await db.product.create({
    data: {
      id: uid("pgr-p"),
      name: "PGR Cart Item",
      slug: uid("pgr-p"),
      categoryId: cat.id,
      price: opts.price,
      status: "PUBLISHED",
    },
  });
  // Product-level (null-variant) inventory row.
  await db.inventory.create({
    data: { id: uid("pgr-inv"), productId: product.id, quantity: opts.stock },
  });
  const variant = await db.productVariant.create({
    data: {
      id: uid("pgr-v"),
      productId: product.id,
      label: "Size: M",
      sku: uid("PGR-SKU-M"),
      priceOverride: opts.variantPriceOverride,
    },
  });
  await db.inventory.create({
    data: { id: uid("pgr-inv"), productId: product.id, variantId: variant.id, quantity: opts.variantStock },
  });
  return { product, variant };
}

async function makeInventoryProduct(name: string, quantity: number) {
  const cat = await db.category.create({
    data: { id: uid("pgr-cat"), name: "PGR Cat", slug: uid("pgr-cat") },
  });
  const product = await db.product.create({
    data: {
      id: uid("pgr-p"),
      name,
      slug: uid("pgr-p"),
      categoryId: cat.id,
      price: 1000,
      status: "PUBLISHED",
    },
  });
  await db.inventory.create({
    data: { id: uid("pgr-inv"), productId: product.id, quantity },
  });
  return product;
}

beforeAll(async () => {
  // Same disposable-DB guard as pg-verify.test.ts, plus a loopback-host
  // check: refuse anything that is not the local disposable cluster.
  // (The pg-tunnel to live Supabase also listens on localhost in this
  // sandbox, so the host check alone is not enough — the database name
  // must be the disposable concurrency DB.)
  const u = new URL(PG_URL);
  expect(["localhost", "127.0.0.1", "::1"].includes(u.hostname)).toBe(true);
  expect(PG_URL).toContain("khareedo_pg_concurrency");
  const applied = await db.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT count(*) AS c FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
  );
  expect(Number(applied[0].c)).toBeGreaterThanOrEqual(18);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("V-1 cart stock join (bare IS -> IS NOT DISTINCT FROM)", () => {
  it("getCartDetailsForCart resolves stock per line: product-level row for a no-variant line, variant row for a variant line", async () => {
    const user = await makeUser(`pgr-v1-${uid("u")}@example.test`);
    const { product, variant } = await makeProductWithVariant({
      price: 5000,
      stock: 7,
      variantStock: 3,
      variantPriceOverride: 4500,
    });
    const cart = await db.cart.create({ data: { id: uid("pgr-cart"), userId: user.id } });
    await db.cartItem.create({
      data: { id: uid("pgr-ci"), cartId: cart.id, productId: product.id, quantity: 2 },
    });
    await db.cartItem.create({
      data: {
        id: uid("pgr-ci"),
        cartId: cart.id,
        productId: product.id,
        variantId: variant.id,
        quantity: 1,
      },
    });

    // On pre-fix code this throws Postgres 42601 (bare `IS` between two
    // columns is a syntax error); on fixed code it returns both lines.
    const details = await getCartDetailsForCart(cart.id);
    expect(details.items).toHaveLength(2);
    const plain = details.items.find((i) => i.variantId === null);
    const variantLine = details.items.find((i) => i.variantId === variant.id);
    expect(plain).toBeDefined();
    expect(variantLine).toBeDefined();
    // The no-variant line must see the PRODUCT-level stock (7), not null
    // and not the variant row's stock (3).
    expect(plain!.stock).toBe(7);
    expect(plain!.quantity).toBe(2);
    expect(plain!.lineTotal).toBe(5000 * 2);
    // The variant line must see the VARIANT row's stock (3) and the
    // absolute price override (4500), not the product price/stock.
    expect(variantLine!.stock).toBe(3);
    expect(variantLine!.quantity).toBe(1);
    expect(variantLine!.price).toBe(4500);
    expect(variantLine!.lineTotal).toBe(4500);
    expect(details.itemCount).toBe(3);
    expect(details.subtotal).toBe(5000 * 2 + 4500);
  });

  it("addToCart + getCartCount exercise join sites :365/:334 through the real service", async () => {
    const user = await makeUser(`pgr-v3-${uid("u")}@example.test`);
    mockSessionUser.id = user.id;
    try {
      const { product, variant } = await makeProductWithVariant({
        price: 2000,
        stock: 5,
        variantStock: 4,
        variantPriceOverride: null,
      });
      // addToCart returns getCartItemCount (:365) after each add.
      const first = await addToCart(product.id, 2);
      expect(first.itemCount).toBe(2);
      const second = await addToCart(product.id, 1, variant.id);
      expect(second.itemCount).toBe(3);
      // getCartCount (:334) counts the same lines, clamped to stock.
      expect(await getCartCount()).toBe(3);
    } finally {
      mockSessionUser.id = "";
    }
  });

  it("the getCartItemCount join shape (sites :334/:365) parses and counts correctly for null and non-null variantIds", async () => {
    // Shape pin complementing the service-level test above: the exact
    // join text of those two sites, run directly with a bound cartId.
    const user = await makeUser(`pgr-v2-${uid("u")}@example.test`);
    const { product, variant } = await makeProductWithVariant({
      price: 2000,
      stock: 5,
      variantStock: 4,
      variantPriceOverride: null,
    });
    const cart = await db.cart.create({ data: { id: uid("pgr-cart"), userId: user.id } });
    await db.cartItem.create({
      data: { id: uid("pgr-ci"), cartId: cart.id, productId: product.id, quantity: 2 },
    });
    await db.cartItem.create({
      data: {
        id: uid("pgr-ci"),
        cartId: cart.id,
        productId: product.id,
        variantId: variant.id,
        quantity: 1,
      },
    });
    const rows = await db.$queryRaw<
      Array<{ quantity: number; status: string; isDeleted: boolean | number; stock: number | null }>
    >`
      SELECT item."quantity", p."status", (p."deletedAt" IS NOT NULL) AS "isDeleted",
             i."quantity" AS "stock"
      FROM "CartItem" AS item
      JOIN "Product" AS p ON p."id" = item."productId"
      LEFT JOIN "Inventory" AS i ON i."productId" = p."id" AND i."variantId" IS NOT DISTINCT FROM item."variantId"
      WHERE item."cartId" = ${cart.id}
    `;
    expect(rows).toHaveLength(2);
    const byStock = rows.map((r) => Number(r.stock)).sort((a, b) => a - b);
    // Product-level row (5) for the no-variant line, variant row (4)
    // for the variant line — a cross join would duplicate/mismatch.
    expect(byStock).toEqual([4, 5]);
    const count = rows.reduce((c, row) => {
      if (row.status !== "PUBLISHED" || row.isDeleted) return c;
      return c + Math.min(row.quantity, Math.max(0, row.stock ?? 0));
    }, 0);
    expect(count).toBe(3);
  });

  it("NEGATIVE PROBE: the pre-fix bare-IS join shape is a Postgres syntax error (42601)", async () => {
    // The exact pre-fix predicate text, run as its own query: if this
    // ever parses, the dialect fact the V-1 fix relies on has changed.
    const probe = db.$queryRawUnsafe(
      `SELECT ci."id" FROM "CartItem" AS ci ` +
        `LEFT JOIN "Inventory" AS i ON i."productId" = ci."productId" AND i."variantId" IS ci."variantId" ` +
        `WHERE ci."cartId" = 'pgr-probe-nonexistent'`,
    );
    await expect(probe).rejects.toThrow(/42601|syntax error/);
  });
});

describe("42P18 adminListInventory CAST (bare $n IS NULL -> CAST($n AS TEXT) IS NULL)", () => {
  it("unfiltered list, search, and low/out filters all work on Postgres", async () => {
    const prefix = `PGRINV-${uid("p")}`;
    await makeInventoryProduct(`${prefix} Low`, 2); // low: 0 < 2 <= 5
    await makeInventoryProduct(`${prefix} Out`, 0); // out
    await makeInventoryProduct(`${prefix} Full`, 50);

    // Unfiltered view: qPattern is NULL — the exact path that threw
    // 42P18 on every call pre-fix (with or without a search term).
    const all = await adminListInventory({});
    expect(all.total).toBeGreaterThan(0);
    expect(all.rows.length).toBeGreaterThan(0);

    const found = await adminListInventory({ q: prefix });
    expect(found.total).toBe(3);
    const byName = new Map(found.rows.map((r) => [r.productName, r]));
    expect(byName.get(`${prefix} Low`)?.isLow).toBe(true);
    expect(byName.get(`${prefix} Low`)?.isOut).toBe(false);
    expect(byName.get(`${prefix} Out`)?.isOut).toBe(true);
    expect(byName.get(`${prefix} Full`)?.isLow).toBe(false);
    expect(byName.get(`${prefix} Full`)?.isOut).toBe(false);

    const low = await adminListInventory({ q: prefix, filter: "low" });
    expect(low.total).toBe(1);
    expect(low.rows[0].productName).toBe(`${prefix} Low`);
    const out = await adminListInventory({ q: prefix, filter: "out" });
    expect(out.total).toBe(1);
    expect(out.rows[0].productName).toBe(`${prefix} Out`);
  });

  it("NEGATIVE PROBE: the pre-fix bare $n IS NULL predicate is a Postgres type error (42P18)", async () => {
    // The exact pre-fix predicate shape with a NULL bound parameter:
    // Postgres cannot infer the parameter type. SQLite accepts it,
    // which is why the SQLite harness never caught the regression.
    const probe = db.$queryRaw`SELECT 1 AS "x" WHERE ${null} IS NULL`;
    await expect(probe).rejects.toThrow(/42P18|could not determine data type/);
  });
});

describe("statement_timeout=30s (src/lib/db.ts)", () => {
  it("SHOW statement_timeout is 30s on a pooled app connection", async () => {
    const rows = await db.$queryRawUnsafe<{ statement_timeout: string }[]>(
      `SHOW statement_timeout`,
    );
    expect(rows[0].statement_timeout).toBe("30s");
  });

  it(
    "a 35s statement is cancelled by the server at ~30s with 57014, and the pooled connection survives",
    async () => {
      const started = Date.now();
      const sleeping = db.$queryRawUnsafe(`SELECT pg_sleep(35)`);
      await expect(sleeping).rejects.toThrow(/57014|statement timeout|canceling statement/);
      const elapsedMs = Date.now() - started;
      // Bounded: cancelled at the 30s timeout, not at completion (35s)
      // and not hanging. Wide bounds for a loaded shared VM.
      expect(elapsedMs).toBeGreaterThanOrEqual(28_000);
      expect(elapsedMs).toBeLessThan(45_000);
      // The connection stays usable after a server-side cancellation.
      const alive = await db.$queryRawUnsafe<{ one: number }[]>(`SELECT 1 AS one`);
      expect(Number(alive[0].one)).toBe(1);
    },
    60_000,
  );
});
