# Khareedo performance engineering report

Date: 3 November 2026. Scope: the working tree supplied with the master prompt, including its existing changes. Historical October measurements are not treated as current baselines.

## 1. Executive summary

Implemented focused cart and category read optimizations in two existing services. No UI, authentication, API-handler, transaction, schema, dependency, environment, pooling, or deployment changes were made.

- Cart details: five SQL requests become three for carts of up to 500 products.
- Header cart count: four SQL requests become two, preserving the narrow stock-aware calculation.
- The count read after adding an item: three SQL requests become one; the existing compact add response is preserved.
- Category navigation/counts: two SQL requests become one, with the same public output.
- All measured service output hashes match the preserved working-tree baseline. Successful cart/quote API JSON also matches exactly.
- 67 tests passed: 44 existing non-database tests, 11 existing order/inventory integration tests, and 12 new isolated regression cases. Build, TypeScript and lint passed.

Service timings improved in the recorded samples, but whole-page results are mixed. In particular, the cart API and unchanged products-page control were slower in the final HTTP sample set. Cold-start delay remains unresolved. These changes do not establish that the entire application meets sub-second targets or is certified for high production traffic.

## 2. Architecture and root causes

The application uses Next.js 16.1.3 App Router, React server components with client interaction components, NextAuth JWT sessions, a service layer, and Prisma 6.19.2. Runtime database access uses the PostgreSQL client and `SUPABASE_POSTGRES_URL`. `DATABASE_URL` and the default Prisma schema remain the separate SQLite tooling/test path. This distinction is unchanged.

Typical rendering flow:

`Request → store layout/settings → header/category/session/cart reads + page service reads → Prisma → Supabase PostgreSQL → view models → HTML/RSC response → client hydration/images`

The homepage already starts banners, categories, featured/new products, promotions, settings and user resolution concurrently. Settings, session/user, existing-cart resolution, full cart details and the shared category getter already use request-level memoization. A fresh anonymous visitor without a cart cookie does not query Cart/User/Wishlist. Full-response static caching is unsuitable for the current personalized header without further separation.

### Confirmed findings

| Finding | Evidence | Resolution |
| --- | --- | --- |
| Cart relation reads require multiple remote requests | Direct details read: Cart lookup, CartItem, Product, ProductImage, Inventory; five observed SQL events | Preserve CartItem read/order; combine bounded product, inventory and first-image reads |
| Count path repeats related-data requests | Narrow count used Cart, CartItem, Product and Inventory reads; four observed events | One joined count-data read after the existing cart lookup |
| Category children are fetched twice as data | Shared query returns every active category, then fetches its active children separately | Build direct children from the existing sorted flat result |
| Round-trip/driver overhead is substantial | Service operations take hundreds of milliseconds while inspected server plans execute in 0.042–0.186 ms | Reduce trips; do not add indexes merely to eliminate sequential scans |
| Results are affected by runtime variation | Unchanged baseline repeats and the products control have materially different HTTP times | Retain all samples; avoid general speed or causal HTTP claims |

The actual PostgreSQL plans used existing Cart, CartItem, Product and Inventory indexes where beneficial. Some small-table image/inventory/category reads used sequential scans. With 51 products and 15 active categories in this sample, their measured execution times do not justify new indexes.

### Not established

- Exact per-request pool acquisition/queue time, network-only latency and pure SSR CPU time were not isolated.
- Fresh diagnostic client connection elapsed time was 1,763.96 ms before and 1,544.94 ms after. This includes initialization/connection work; it is not a measurement of pool wait alone.
- The exact cause of the first homepage request was not identified. Engine/module initialization, connection establishment, first-use statements and transport remain profiling candidates.
- A database connection attempt failed during browser setup and succeeded on retry. No connection or timeout settings were changed to conceal it.
- The source's existing session-pool connection-limit fallback and TLS verification were retained, including any URL override. No pooling fix is claimed. Deployment instance/client counts and actual remaining pool capacity need operational inspection.

Prisma query-event duration includes the client/database exchange, rather than only PostgreSQL execution; it must not be labeled SQL CPU time. [Prisma query-event reference](https://docs.prisma.io/docs/orm/v6/reference/prisma-client-reference)

## 3. Files modified by this work

| File | Reason |
| --- | --- |
| `src/services/cart.service.ts` | Typed, parameterized bounded product-relation reads; narrow joined count read. Existing identity resolution, calculations, mutation response, validations and write operations retained. |
| `src/services/categories.service.ts` | Remove redundant child relation read and reconstruct the same two-level navigation from sorted active rows. Product-count filtering remains intact. |
| `tests/unit/cart-categories.performance.test.ts` | Twelve real-SQL, marked-temporary-database regressions for behavior, ownership, freshness, binding, large carts, category hierarchy/counts and credentials-provider behavior. |
| `worklog.md` | Current findings, measurements, verification and unresolved issues appended after the existing history. |
| `docs/PERFORMANCE-ENGINEERING.md` | This report. |

There were 27 pre-existing tracked-file changes and an untracked timing module. Initial hashes and source snapshots were preserved outside the repository. Files outside the two target services and this work log are checked against that initial snapshot; existing edits were not reverted or committed.

## 4. Optimizations explained

### Cart details

The original cart-item query still retrieves the same rows in its existing order. A second, parameterized query retrieves product fields, inventory and the first `sortOrder` image for those product IDs. Results are matched by product ID; they do not reorder cart lines. Product IDs are bound through `Prisma.sql`/`Prisma.join`, not inserted into SQL strings.

Product queries are processed sequentially in batches of 500. This bounds parameter counts without truncating the cart or launching uncontrolled parallel work. A 1,001-item fixture verifies batch boundaries and completeness. The existing ProductImage/product and Inventory/product indexes remain available; no schema changes are needed.

The original calculations are preserved: unpublished/deleted products are excluded; current prices remain authoritative; available units use `min(requested quantity, max(stock, 0))`; zero/missing inventory remains unavailable; subtotals, original requested quantities, low-stock thresholds and wrapping units retain their existing meanings.

### Badge and post-add count

The separate narrow count path is intentionally retained. It fetches quantity, publication/deletion state and stock in one joined query, then uses the same JavaScript reduction as before. It avoids fetching images and prices solely for a browsing-page badge. The existing request cache still shares cart identity, and full details remain request-cached for callers that need them.

An intermediate full-detail badge reuse experiment was rejected because it loaded unnecessary fields on badge-only pages. The final strategy reduces overlapping requests while retaining a small standalone summary read. It does not claim to eliminate every overlapping field read between header and page.

### Categories

The shared getter still returns active categories, the same ordering and published/nondeleted product counts. Children are grouped by `parentId` from those rows. Active roots and direct children retain their fields; inactive parents/children are not promoted; grandchildren are not newly exposed. Existing equal-`sortOrder` ties remain unspecified; no new ordering policy was introduced.

### Trade-offs and freshness

The cart service now contains two small SQL reads with explicit column names. Future schema changes must maintain those reads; real PostgreSQL reads and SQLite regressions cover the current schema. No persistent cache was added. Price, stock and private account/cart data are not cached across requests. Current SSR cache behavior remains request scoped. [Next.js request memoization documentation](https://nextjs.org/docs/15/app/guides/caching)

## 5. Before-and-after performance

### Method

Both HTTP versions were built from the supplied working tree and run on audit port 3102 with the same application connection settings. There was initially no server on port 3000. No artificial diagnostic pool-size override was used.

Direct service measurements use the same database configuration in a separate process, with guest identity supplied only to that diagnostic process. The preserved source snapshots supply the original functions; no Git checkpoint reset was used. React render memoization is inactive for these direct calls, so their query counts are per service call, not instrumented counts for an entire RSC request.

Service figures are the median of four warm calls after one first-use call. HTTP figures are the median of three warm requests after one first observed request. Shared database caches were not flushed. TTFB, full HTTP response, service duration, query-event duration and server SQL execution are separate measurements.

### Service reads

Times are milliseconds. Percentages describe the observed medians, not production guarantees.

| Metric | Before | After | Observed reduction | SQL events before → after |
| --- | ---: | ---: | ---: | ---: |
| Cart details including resolution | 906.73 | 577.99 | 36.3% | 5 → 3 |
| Cart badge including resolution | 660.05 | 407.00 | 38.3% | 4 → 2 |
| Post-add count read, without performing an add | 705.83 | 155.94 | 77.9% | 3 → 1 |
| Category navigation | 492.97 | 245.73 | 50.2% | 2 → 1 |
| Category list/counts | 430.59 | 200.33 | 53.5% | 2 → 1 |

Serialized Prisma-result bytes changed from 469 to 433 for details, 128 to 100 for the badge, 94 to 66 for the post-add count, and 5,582 to 3,640 for categories. These are diagnostic JSON materialization sizes, not PostgreSQL wire traffic or process memory. All service output hashes match across every before/after sample.

### Production HTTP

Guest cart routes use the same existing populated cart through an in-memory cookie. Reads and quotes do not modify it.

| Metric | Before ms | After ms | Observed change |
| --- | ---: | ---: | --- |
| Cart page | 1696.03 | 1550.69 | 8.6% lower |
| Checkout page | 1083.17 | 915.73 | 15.5% lower |
| Checkout quote | 1641.57 | 922.08 | 43.8% lower |
| Homepage, no cart cookie | 1968.89 | 1798.18 | 8.7% lower |
| Homepage, populated cart | 2560.10 | 1940.46 | 24.2% lower |
| Cart GET API | 899.79 | 1309.54 | **45.5% higher** |
| Products page, control | 1327.09 | 2605.91 | **96.4% higher** |
| First homepage request | 5453.80 | 6352.49 | **16.5% higher** |
| Header duration alone | N/A | N/A | Not isolated |
| Pure server-render CPU / process memory / largest page bundle | N/A | N/A | Not reliably measured |

All measured HTTP requests returned 200. Cart API and quote JSON hashes match exactly, with unchanged 452-byte and 176-byte payloads in the sampled fixture. Raw files also retain TTFB and every sample.

An unchanged-baseline repeat produced a 1,321.77 ms cart median versus the original 1,696.03 ms, demonstrating substantial variation even without code changes. Therefore HTTP percentage differences are descriptive, not proof of uniform improvement. The cart API regression and slower control are explicitly retained; neither cold start nor all latency targets can be declared fixed.

The new SQL plans execute in 0.042–0.186 ms on this data. This supports reducing remote round trips rather than adding unproven indexes. It does not separate transport, pool wait, driver overhead and rendering inside an HTTP request.

## 6. Testing results

| Check | Actual result |
| --- | --- |
| `npm run build` | PASS on baseline and final application source; existing client generation and Next.js build only, no migrations |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | PASS |
| `node node_modules/eslint/bin/eslint.js .` | PASS |
| Existing pricing/validation/import/auth unit files | 44/44 PASS |
| Existing order/inventory integration file | 11/11 PASS, unchanged tests and timeouts |
| New cart/category/auth regression file | 12/12 PASS |
| New tests plus existing integration suite | 23/23 PASS, 7.44 s in the final isolated run |
| Read-only HTTP validation | Nine checks PASS: 307 account redirect; 401 admin/wishlist authorization; 404 product/order; 422 malformed cart, checkout and registration |
| Read-only browser smoke using installed Edge | Four pages return 200, no page errors or mutation requests; checkout quote POST is allowed because it is read-only |
| Browser visible content | All four main-content hashes match; mobile destinations remain Home, Shop, Cart, Account |
| Strict screenshots | Cart, checkout and mobile products are byte-identical. Homepage differs by two one-level RGB values at the search-input border, out of 1,229,400 pixels; reviewed images show no layout/content change. The strict byte comparator exits 1 on that difference; this is not reported as a fully identical screenshot. |

Tests cover stock clamping, unpublished/deleted products (including an epoch deletion timestamp), missing inventory, image order, prices, gift wrap, mutation response shape, cart ownership, signed-in versus guest priority, current-data reads, quoted SQL parameters, a 1,001-item cart, navigation hierarchy/counts, verified credentials, wrong passwords and unverified email. Existing integration coverage retains order/payment snapshots, idempotency, conditional inventory and cancellation/coupon behavior.

The standard `test:db` command was not run because it invokes prohibited `prisma db push`. Instead, a helper read only SQLite schema metadata, created an exclusively new marked OS-temporary database, inserted test fixtures there, passed the unchanged isolation guard, and removed only its verified temporary directory. No application rows were copied. Native SQLite required the normal unsandboxed temporary directory; the guards were not weakened. An initial test fixture incorrectly used fractional values for integer-price models and was corrected. A run concurrent with browser load hit the existing five-second test timeout; the unchanged suite passed when run without that concurrent load.

No dependencies or browsers were installed. The separate Playwright Chromium download was absent, so existing Edge was used. Mutating production Playwright suites, actual OAuth/email delivery, external payments, and valid admin writes were not executed against application data. Credentials-provider behavior was exercised with disposable users, not real account passwords. The existing Vite configuration-loader warning remains.

## 7. Remaining issues

| Priority | File/function | Evidence and next step |
| --- | --- | --- |
| High | `src/lib/db.ts`, request lifecycle | Cold starts, intermittent connection setup and variable end-to-end latency remain. Correlate connection creation/acquisition, query events, SSR CPU and response completion on a representative deployment before tuning. |
| High, approval required for behavior changes | `cart.service.ts` cart creation/add; `wishlist.service.ts` toggle | Existing find/create and read/absolute-write patterns can race. Conditional inventory and order idempotency remain in place. Specify retry/merge semantics before changing these operations. |
| Medium, source finding requiring controlled validation | `addToCart`, cart POST | Cart creation precedes product availability checks, and the cart endpoint has no dedicated rate limiter. Validly shaped requests for unavailable IDs can leave empty guest carts. No abuse traffic or cleanup was run; define creation/limiting/retention behavior before changing it. |
| Medium, needs business decision | `checkout.service.ts` quote and placement | Source inspection shows quote calculations use requested line quantity, while cart display totals clamp to stock; placement separately rejects excess quantity. Validate the intended quote behavior before changing it. |
| Medium, approval required for consistency changes | Post-commit cart clearing | A committed order can outlive a cart-clear failure; concurrently added items may also be cleared. Do not change consistency semantics as an incidental read optimization. |
| Medium | Reports/customer summaries/exports | Growing order histories are materialized for application-side aggregation. Preserve dates, numeric output and cancellation rules in any later SQL aggregation. |
| Medium | Product list/featured/new relation reads | Existing batching avoids per-card N+1 queries but still uses multiple relation requests per section. Profile bounded shared relation loading before a larger refactor. |
| Medium at larger scale | Category product counts | The retained aggregate scans published product history; currently negligible on 51 products. Reassess with representative catalog size rather than removing counts required by filters. |
| Medium | Test infrastructure | The normal disposable runner still uses db push. A separately reviewed non-destructive CI schema setup is needed before routinely running the new opt-in SQL file there. |
| Low/unmeasured | Images/client bundles | Image priority, responsive sizes, hydration, chart bundles and LCP/CLS need browser resource profiling; no frontend changes are justified by the current server-read measurements. |

There is no measured evidence that Redis, microservices, a queue or a new paid service is required. Successful password-provider tests do not certify the entire browser login/OAuth flow or all security controls. Per-instance rate limiting and production error-log redaction still need deployment-level review.

## 8. Scalability assessment

The tested read path handles a 1,001-item temporary cart without truncation and bounds product-query parameters to 500 per batch. This is a functional large-fixture result, not a production latency or memory-capacity promise. Cart and category work remains proportional to returned data; no arbitrary item/category caps were introduced.

One production burst of five concurrent read-only cart GETs returned five 200s with identical JSON hashes, completing in 2,454.65 ms overall; individual requests ranged from 2,253.35 to 2,416.78 ms. This demonstrates correctness for that small burst, not sustained traffic capacity. No production write-load or PostgreSQL oversell test was run.

Connections multiply across processes, runtime clients and deployment instances. The historical session-capacity concern and the existing source fallback require actual instance/client-budget measurement. Neither raising nor lowering pool limits is justified from these latency samples alone. TLS verification and optional CA handling must remain intact.

## 9. Recommendations

**Immediate:** retain the focused changes and capture per-request production timing with separately identified connection/acquisition, database exchange, rendering and delivery stages. Investigate the slower cart API/control and cold request before claiming broad gains. Preserve all current guards and transaction rules.

**Medium term:** evaluate product relation batching and exact database-side report aggregates on representative fixtures; make a non-destructive test runner portable; inspect large-cart image lookups and category aggregates at realistic catalog sizes. Keep public cache invalidation tied to every admin write before introducing persistent caching. No global cart, account, checkout or private admin cache is recommended.

**Long term, with approval where applicable:** validate connection budgets and deployment region against the real Supabase tier and concurrency; stress-test PostgreSQL order/inventory behavior in an isolated staging environment; specify concurrent cart/wishlist/checkout semantics before implementing fixes. No new architecture or paid infrastructure is proposed for immediate implementation.

No new index is recommended now. If large galleries later make first-image lookup expensive, a `(productId, sortOrder)` image index could avoid sorting rows selected by the existing product-ID index; it adds one index entry per image and sort-order write/storage maintenance. If published-category aggregation becomes expensive, reassess a publication/deletion/category index with real plans and selectivity. Existing current-volume plans are insufficient evidence for either migration; explicit approval is required before schema/index work.

## 10. Safety, evidence and runtime state

- No credentials, passwords, session cookies, API keys or environment-file contents were included in the report or saved measurements. Diagnostic errors were sanitized after an initial connection error displayed a database hostname.
- No application database data was created, updated, deleted or transferred by this work. Only disposable test fixtures were changed and removed.
- No Prisma migrations, db push/reset, application seed scripts, application schema/index changes or database-credential changes were run. Fixture-only writes/deletes occurred exclusively in marked temporary databases; no destructive SQL targeted application data.
- `.env`, `.env.example`, authentication, API handlers, business write/transaction code, pooling and TLS configuration were not edited.
- No frontend source, styling, layout, logo, branding or mobile-navigation implementation was changed.
- No source project files were deleted or renamed. No dependency installation, Git commit, branch creation or push occurred.
- Unrelated pre-existing files were verified against initial hashes. The targeted cart service retains the supplied identity, validation, mutation and timing changes.

Raw evidence, source snapshots and local reproduction helpers are in:

`C:/Users/madee/.codex/visualizations/2026/10/30/01a18e9c-9bc3-70b2-94c4-3d1a52008897/master-performance/`

Relevant files: `initial-state.json`, `baseline-measurements.json`, `baseline-services.json`, `after-measurements.json` (including sanitized plan metadata), `readonly-burst.json`, `sqlite-tests.json/log`, `baseline-visual.json`, `after-visual.json`, `visual-review.json`, and the original service snapshots. `candidate-measurements.json` is an intermediate experiment whose HTTP requests still used the baseline build; it is not the final after result.

Local reproduction helpers: `measure.cjs`, `sqlite-tests.cjs` and `visual.cjs`. The new SQL tests are intentionally skipped without the marked disposable-database environment; never point them at application data. The full production build contains the optimized application code. The audit server was stopped after verification. Changes are local and uncommitted; nothing was deployed or pushed.

## 11. Product listing and detail follow-up — 2026-11-03

### Changes

- Category-filtered product listings now express the selected category and its direct children in the product relation filter. This removes the separate category-scope lookup before the listing and count reads. Active-category filtering and the existing direct-child scope are preserved.
- Product detail reads now select only fields used by the storefront. Metadata is derived from the request-memoized product detail read instead of issuing a second, separate product query.
- The isolated SQLite test runner accepts explicit test files only from `tests/unit`, so the cart/category SQL regressions can run through the same disposable-database guard.
- `scripts/audit-perf.mjs` accepts `PERF_BASE_URL` and `PLAYWRIGHT_EXECUTABLE_PATH`, and prints raw samples alongside medians for reproducible runs with an installed browser.

### Measurements and limits

Before these follow-up changes, seven sequential read-only homepage requests against the local production build all returned 200. Response times ranged from 1,817 to 4,624 ms; the median was 2,436 ms. A three-navigation Edge sample had desktop `/products` median TTFB/LCP of 1,737/2,112 ms, desktop product detail 2,901/3,024 ms, and mobile product detail 1,750/1,904 ms. These are small-sample baselines, not guarantees.

No post-change production/browser comparison is claimed. A shared Next.js development process held the `.next` build lock, and I left it untouched rather than stop the user's process or overwrite its build output. An isolated-copy build also could not resolve Windows `node_modules` junctions. The query-path changes are behavior-tested, but their user-visible latency improvement remains unmeasured and the acceptance gate is therefore not fully met.

### Follow-up verification

- TypeScript check passed.
- Full ESLint passed.
- 44 non-database unit tests passed.
- 13 order/inventory integration tests passed through the marked disposable SQLite harness.
- 12 cart/category SQL regression tests passed through that same harness.
- No application database writes, migrations, seeds, or production-data tests were run.
- `git diff --check` still reports one pre-existing trailing-whitespace line in `src/app/(store)/products/page.tsx`; it was left unchanged to preserve unrelated user work.

The initial worktree snapshot and SHA-256 manifest are retained in the session files directory, excluding environment files.

## 12. Admin query round-trip reduction — 2026-11-04

The supplied runtime trace showed an admin settings save issuing 18 individual upserts, with each Prisma operation completing in approximately 4.4 seconds and the request taking 5.3 seconds. The settings service now writes all supplied keys through one parameterized `INSERT ... ON CONFLICT DO UPDATE`; empty updates remain no-ops.

The admin dashboard's nine independent headline-stat queries are now one parameterized query with scalar aggregates. Existing status, date-window, product-deletion and low-stock rules are retained. The dashboard's charts and recent-item reads remain separate.

Regression tests verify the one-query shapes and returned dashboard values. TypeScript and targeted ESLint checks pass. These round-trip reductions are verified structurally; no post-change production or end-to-end latency comparison was run, so a response-time improvement is not yet measured. Connection-pool and deployment settings were not changed.
