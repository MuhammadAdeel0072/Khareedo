# Khareedo homepage performance engineering report

Date: 4 November 2026 (Asia/Karachi). Scope: the supplied working tree, including its existing uncommitted optimizations. Runtime: Next.js 16.1.3, Prisma 6.19.2, Node.js 24.21.0, local Windows standalone production server and the configured Supabase PostgreSQL database.

## Result

Warm anonymous homepage SQL reads fell from **7 to 5 on every measured request**. Image preloads fell from **8 to 2**, retaining the first hero and existing logo preload. Authenticated wishlist loading now starts as soon as user verification finishes, independently of public catalogue reads.

The two isolated HTTP comparison sets, combined, have warm median TTFB **683.25 ms before / 644.36 ms after** and average **726.13 / 693.55 ms** (16 warm requests per version). These small aggregate differences **do not establish a substantial or consistent TTFB improvement**: one comparison improved and the confirmation comparison was slightly slower. Warm medians were already below one second in the supplied source; one optimized warm request still took 1,289.60 ms. Cold starts remain slow and were worse in the normal-production HTTP samples.

TypeScript, ESLint, production build and **89 tests passed**. Desktop/mobile content and product hashes match, and their before/after screenshots are byte-identical. Current prices, stock, verified-user/wishlist rendering and subsequent anonymous isolation passed read-only production checks. All pre-existing source edits were preserved.

## 1. Audit, request lifecycle and evidence

The audit preceded application edits. It covered the complete homepage, its imported components, root/store layouts, header/footer/mobile navigation, image/carousel/product controls, authentication guards, relevant services, database utility, proxy, existing timing code, logs, test harness and prior performance reports.

Request lifecycle:

1. The root layout supplies self-hosted `next/font` fonts and global styles. The proxy matcher excludes `/`.
2. Store layout reads settings for header/footer. The homepage concurrently reads HERO/SIDE banners, categories/counts, featured products, arrivals, promotions and verified-user state.
3. The header reads navigation/session/cart count. Existing React request memoization shares settings, categories and session work. A new anonymous visitor has no User, WishlistItem or Cart read.
4. Products already use narrow list selections and Prisma relation joins. Category reads are already shared. There is no homepage per-card N+1 pattern.
5. Server components build HTML/RSC. Client components hydrate interactive controls; responsive optimized images load in the browser.

| Finding | Location | Evidence and implication |
| --- | --- | --- |
| Two editorial reads on every anonymous request | `banners.service.ts`, `page.tsx` | Native SQL-event probes observed 7 reads: settings, HERO, SIDE, categories, featured, arrivals, promotions. Warm banner caching removes exactly the two Banner reads; all 24 optimized warm probes observed 5 reads. |
| Wishlist has an unnecessary dependency | `page.tsx` | Previously started after the entire public `Promise.all`. A deferred-public-read regression proves the new verified-user → wishlist chain starts while public work remains pending. This is a scheduling improvement; a signed-in before/after latency gain was not measured. |
| Competing preloads include invisible content | `hero-carousel.tsx`, `page.tsx` | All three slides plus four featured cards were prioritized, alongside the logo. Browser DOM shows 8 preloads before and 2 after. |
| Production diagnostics were incomplete/misnamed | `performance-timing.ts`, `db.ts`, `page.tsx` | Existing operation timing was disabled in production; SQL events were development-only; raw Prisma calls were omitted; `after()` duration was called `server-render-total`. These gaps are corrected without adding a second application timing framework. |
| Remote database operations dominate much of the warm wait | SQL/engine probe and opt-in production timings | Before: 112 SQL events across 16 isolated warm requests, median event duration 169 ms; after: 80 events, median 201.5 ms. A separate optimized debug request spent 648 ms in data waits and 649 ms in the page function, versus 774 ms HTTP TTFB. Another spent 381 / 382 / 505 ms. This supports reducing database work, but does not identify PostgreSQL CPU, transport, connection acquisition or pool wait separately. |
| Cold first-use work remains expensive | Production HTTP samples | First-request TTFB was 4.70–5.37 s before and 5.61–6.00 s after in the isolated comparison sets. No cold-start fix is claimed. |

No blocking external service request, large homepage transformation, redundant per-card database call or unnecessary guest User/Wishlist lookup was found. Existing independent public reads already used `Promise.all`, so they were retained. Existing fonts use `display: swap`; no font or CSS replacement was justified.

The configured URL has no explicit connection limit; the existing Supabase session-pool fallback remains 3. Its TLS verification, optional CA handling, URL overrides and Prisma reuse are unchanged. More than three independent operations can contend for that pool, but exact pool-wait time was not isolated. Historical sub-millisecond query plans were reviewed as context, not reused as current execution measurements. No index/schema change was justified.

## 2. Files changed and exact implementation

| File | Change |
| --- | --- |
| `src/services/banners.service.ts` | Explicit Next `unstable_cache` for public active banners, keyed by placement and limit, tagged `storefront-banners`, with a 60-second revalidation interval. Reconstruct Date fields after JSON cache storage. Create/update/delete immediately expire all banner variants with `revalidateTag(tag, { expire: 0 })` only after successful writes; existing return values and write payloads remain intact. |
| `src/app/(store)/page.tsx` | Overlap verified-user/wishlist chain with public reads. Remove the unused homepage settings dependency (layout still reads settings; this is not counted as a SQL reduction). Remove four below-hero featured-image priorities. Measure page-function/data waits and rename the response-tail measurement. |
| `src/components/home/hero-carousel.tsx` | Prioritize only the initial hero slide, preserving every slide, controls, autoplay, dimensions and responsive sizes. |
| `src/lib/performance-timing.ts` | Reuse timing wrappers in production only when `LOG_LEVEL=debug`; normal production bypasses their timer/context overhead. Export the shared logging switch. |
| `src/lib/db.ts` | Enable debug SQL-event durations and client-wide sequence counts in production; time raw as well as model operations. Log no SQL text, parameters or unreliable SQL-event request attribution. |
| `tests/unit/homepage.performance.test.ts` | Five dependency/personalization/product-data regressions. |
| `tests/unit/homepage-banners.performance.test.ts` | Nine cache-boundary, argument, Date, mutation/invalidation and failure-contract regressions. |
| `tests/unit/performance-timing.test.ts` | Six opt-in logging/context/error/default-production regressions. |
| `docs/HOMEPAGE-PERFORMANCE-2026-11-04.md` | This report. |

Prices, inventory, scheduled promotions, checkout settings, session/authorization state and private data are not persistently cached. The full page remains dynamic. The banner interval uses Next's stale-while-revalidate behavior, so it is not a hard maximum age; successful application banner mutations use immediate expiration. Direct/out-of-band database edits and independent deployment instances need their normal cache-coordination consideration. This cache is limited to editorial banners.

Installed Next 16.1.3 source was checked for `unstable_cache` compatibility with the existing dynamic page and for immediate tag expiry from Route Handlers. The global Cache Components mode was not enabled. Framework references: [unstable_cache](https://nextjs.org/docs/app/api-reference/functions/unstable_cache), [revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag).

## 3. Measurement method and HTTP results

The baseline was freshly built from the supplied source and copied to an independent standalone directory before editing. Baseline and optimized servers ran sequentially on `127.0.0.1:3104`, using the same Node version, database settings and TLS/pool configuration. Each process received one first request followed by eight warm anonymous document requests, without cart/session cookies, at 200 ms spacing. All returned HTTP 200. No application/database cache was globally flushed.

The same diagnostic preload counted native Prisma SQL events and engine-call elapsed durations for both versions. It does not log SQL/parameters. Requests were sequential, allowing event counts within individual request windows; this technique must not be used to attribute client-wide events to concurrent requests. Engine-call elapsed duration includes more than PostgreSQL execution, and overlapping durations must not be summed into TTFB.

Times below are milliseconds; first requests are excluded from warm statistics.

| Set / version | First TTFB | Warm n | Warm median | Warm average | Warm min | Warm max | SQL/warm request |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial / before | 5,373.31 | 8 | 738.90 | 769.84 | 540.18 | 1,074.58 | 7 |
| Initial / after | 6,002.34 | 8 | 644.36 | 649.98 | 452.12 | 922.07 | 5 |
| Intermediate / before | 4,784.53 | 8 | 806.48 | 771.14 | 582.18 | 956.98 | 7 |
| Intermediate / after | 5,688.59 | 8 | 552.90 | 567.11 | 370.70 | 791.61 | 5 |
| Confirmation / before | 4,704.70 | 8 | 683.25 | 682.42 | 566.18 | 818.81 | 7 |
| Confirmation / after | 5,613.76 | 8 | 694.07 | 737.13 | 470.66 | 1,289.60 | 5 |

A final TypeScript check overlapped the intermediate sample set, so that pair is retained for transparency and excluded from the primary aggregate. The initial and confirmation sets ran with build/test/check workloads stopped.

| Primary aggregate: initial + confirmation | Before | After |
| --- | ---: | ---: |
| Warm requests | 16 | 16 |
| Median TTFB | 683.25 | 644.36 |
| Average TTFB | 726.13 | 693.55 |
| Min / max TTFB | 540.18 / 1,074.58 | 452.12 / 1,289.60 |
| Median total HTTP response | 696.03 | 654.56 |
| SQL events / warm request | 7 | 5 |

The aggregate median is 5.7% lower, but the isolated pairs differ: initial −12.8%, confirmation +1.6%. These observations do not prove a consistent causal speedup, lower tail latency, or cold-start improvement. The earlier supplied 1.46–2.67 s observations are not the baseline for this change. There is no claim that these edits newly achieved sub-second warm medians: this working tree already met that median target locally.

Early probe-setup trials (`baseline.json`, `baseline-instrumented.json`) lacked working SQL-event capture and are excluded from the comparison. Their raw files remain available; the final `before*.json` / `after*.json` use the same corrected probe.

## 4. Timing definitions and production instrumentation

Set `LOG_LEVEL=debug` to enable slow-operation warnings in production. Routine SQL and per-operation timing details are not printed; normal production remains quiet unless an operation exceeds the slow threshold.

| Metric | Meaning / limitation |
| --- | --- |
| HTTP TTFB | Client elapsed time until response headers begin. Browser report also records `responseStart - requestStart` separately from navigation-start-to-first-byte. |
| `homepage.data-fetch` | Elapsed wait for the page's data group, including async waits; not database execution time. |
| `homepage.component` | Page async function, including data waits and React element construction. Does not include all descendant rendering or isolate rendering CPU. |
| `component-start-to-response-finished` | Page start through the `after()` callback after response completion. Includes async waits and descendants; neither TTFB nor pure SSR CPU. |
| Prisma operation duration | Application operation elapsed time, including driver/engine/pool waits where applicable. Raw operations are included; one operation need not equal one SQL query. |
| SQL-event duration/count | Prisma engine client/database exchange; not pure PostgreSQL CPU. Events use clientId/sqlSequence, deliberately without request IDs because engine callbacks do not reliably retain request context. |
| Browser load / FCP / LCP | Browser loading/paint milestones. Separate from TTFB and server timings. |
| CLS | Observed layout shift score, separate from timing duration. |
| INP | Interaction responsiveness; not measured by these short smoke navigations. |

Prisma defines query-event duration as elapsed client/database exchange rather than server-only execution: [Prisma v6 query-event reference](https://docs.prisma.io/docs/orm/v6/reference/prisma-client-reference). Next documents `after()` as running after the response finishes: [after reference](https://nextjs.org/docs/app/api-reference/functions/after).

In a separate production-debug run, anonymous data-group/page-function/response-tail durations were 648/649/772 ms and 381/382/505 ms. SQL counts were five per warm anonymous window. The read-only signed-in render returned 200 with eight SQL events, current role verification, raw stock-aware cart count and a fresh wishlist read. Its single 1,228.78 ms TTFB is a functional diagnostic observation, not a signed-in performance baseline.

Pure server rendering CPU, exact connection-acquisition cost, transport-only latency and PostgreSQL execution time have not been isolated. No claim that the database server itself is slow is made.

## 5. Browser and correctness verification

Installed Edge/Playwright ran fresh signed-out desktop (1366×900) and mobile (390×844) contexts against both versions. These are single, unthrottled laboratory observations. Desktop was the first homepage after process startup; mobile used the already-running process. They are not comparable cold/warm profiles and are not field Core Web Vitals.

| Profile / version | Request TTFB ms | FCP ms | Observed LCP ms | Load ms | CLS | Image preloads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop before | 5,195.6 | 7,012 | 7,032 | 6,196.9 | 0 | 8 |
| Desktop after | 4,381.6 | 6,096 | 6,128 | 5,399.0 | 0 | 2 |
| Mobile before | 1,003.8 | 1,516 | 1,532 | 1,587.4 | 0 | 8 |
| Mobile after | 807.2 | 1,296 | 1,312 | 1,436.0 | 0 | 2 |

These samples are descriptive only; they do not establish an LCP improvement or an INP result.

- All four navigations returned 200; all five homepage sections, twelve product cards, links, prices/stock controls, category navigation and mobile destinations match.
- Main-content/product hashes match on both viewports. Before/after screenshots are byte-identical for each viewport, and visual inspection found no regression.
- Carousel selection moved to slide two and back; dimensions and responsive behavior remain intact; no horizontal overflow.
- Zero console errors, page exceptions, HTTP failures, image/font/document failures or attempted mutation requests.
- Browser request-abort counts were 22/18 before and 22/16 after, desktop/mobile. Every recorded abort was a `fetch` with `net::ERR_ABORTED` on linked-page paths. Cancelled Next prefetches are a plausible inference; headers were not captured to prove that attribution. These are not presented as zero failed requests.
- Top-of-page screenshots show the same unloaded below-fold lazy images in both versions; this does not assert that every offscreen image was loaded.
- Read-only diagnostics compared displayed current prices and stock to the actual database, verified account/wishlist controls for an existing verified customer using an in-memory locally signed NextAuth JWT, and then verified a fresh anonymous request had no private wishlist/user queries or personalized controls. No token, customer identity or response body was saved by that harness.
- Anonymous `/account` returned 307 to login. Anonymous `POST {}` to `/api/account/addresses` returned 401; the existing guard executes before parsing/write logic, so no address was created.

The local JWT check verifies existing session consumption/rendering and current DB user checks. It is not a password/browser OAuth sign-in test. Existing credentials tests ran only with disposable users. No production checkout, payment, cart/wishlist mutation, admin banner mutation or external OAuth/email flow was exercised.

## 6. Test results and preservation

| Check | Result |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | PASS before and after build |
| `npm run lint -- --ignore-pattern tool-results/** --ignore-pattern .next-db-latency/**` | PASS; excludes audit/build output while using the existing ESLint script/config |
| `npm run build` | PASS for baseline and optimized source; existing client generation and production build only |
| All unit/integration/regression suites | 9 suites, 89 tests PASS: 44 existing unit tests, 25 existing disposable integration/regression cases, 20 new focused tests |
| Production HTTP | All 54 requests in the six reported sample sets returned 200 |
| Browser and read-only auth/data checks | PASS with the limitations above |
| Existing source preservation | Initial hash manifest contains 342 files. Exactly the five intended application files differ; all unrelated pre-existing tracked/untracked files in that manifest retain their hashes and exist. Three focused test files and this report are new. |

The normal `test:db` runner invokes prohibited `prisma db push`, so it was not run. The audit-only runner read SQLite schema metadata from `db/custom.db` with a read-only handle, created a new marked OS-temporary database with the same empty schema, and used the unchanged isolation guard. It copied zero application rows, gave child workers no real PostgreSQL credentials, ran the existing tests unchanged, and removed only its verified marked temporary directory. No migration, schema edit, destructive SQL or application DB reset occurred.

An initial restricted-temp test run failed because Prisma could not open the sandbox fixture path. The same guarded runner passed in the normal Windows temp directory. The first restricted build also failed to fetch existing Google Fonts; the network-enabled build passed. An unqualified ESLint run was interrupted while traversing copied audit output; the script passed with the explicit generated-output exclusions above. These environmental/setup failures are retained, not treated as passing runs. The existing Vite configuration-loader warning remains.

## 7. Remaining bottlenecks and next steps

1. **Profile cold start on the actual deployment.** The multi-second first request persists. Separate module/engine initialization, TLS/connection setup, first statements and rendering before tuning. The current edits do not fix cold start.
2. **Collect representative production distributions.** Use the opt-in operation logs for a bounded diagnostic period and platform/request tracing for concurrent request attribution. Measure p50/p95 TTFB for anonymous, guest-cart and signed-in traffic near the deployed database. Local medians and a single signed-in diagnostic do not establish production tail latency.
3. **Keep pool changes evidence-based.** Five live anonymous SQL reads and authenticated user/cart/wishlist work still incur remote waits. Verify deployment instance/client connection budgets and region/transport latency; do not raise the current pool limit or add indexes from these samples alone.
4. **Validate editorial cache operations in deployment.** Tests cover all service invalidation calls; production warm probes verify actual cache hits. Real admin writes were deliberately not performed against application data. Use normal staging/admin workflows to check edit visibility and any multiple-instance cache coordination.
5. **Collect field LCP/INP/CLS and cold/warm image profiles.** Fewer preloads are verified; real-user paint/responsiveness improvement needs representative mobile measurements. Keep live stock/prices/authorization uncached.

## Evidence artifacts

Audit artifacts are in `tool-results/homepage-20261104/` (Git-ignored), including the preserved baseline standalone build, original source/hash snapshots, probe/test/browser/diagnostic scripts, all raw timing samples, `summary.json`, production debug timings and desktop/mobile screenshots. No unrelated source was reverted, deleted or committed. No schema, dependency, Supabase setting or new infrastructure was introduced.

## 8. Follow-up: read-only homepage database latency audit

This section records a subsequent investigation of the reported 1.57 s production TTFB. It uses fresh measurements of the current build, not the preceding optimization's before/after samples. **No application/query/pool change was made in this follow-up.**

### Finding

**Database access latency contributes substantially to the measured server wait, but slow PostgreSQL query execution is not the observed cause.** The captured application SELECTs have per-statement execution medians of approximately **0.03–1.18 ms** on PostgreSQL. A warm trivial `SELECT 1` through the same configured endpoint takes **145.37 ms median**, and an independent SSL-request round trip takes **152.10 ms median**. A three-connection Prisma pool adds another wave of waiting when more than three operations are ready together.

In the normal-production sample, the union of intervals awaiting native database operations covers a median **87.5% of anonymous TTFB** and **92.2% of signed-in TTFB**. Percentages are computed within each request and then summarized, rather than dividing independently calculated medians. This is wall-time coverage, not isolated PostgreSQL CPU or a claim that every covered millisecond is exclusively caused by the database. Some application CPU work overlaps those waits.

The reported browser request at exactly 1.57 s was not captured with a correlated trace. These local samples establish the dominant database-access mechanism under the tested conditions; they cannot fully attribute that individual browser measurement or certify deployment-wide latency.

### Method and scope

- Inspected the current page, layouts, header, services, authentication guards, Prisma configuration and existing instrumentation before measuring.
- Used the existing standalone production build, Node 24.21.0, PostgreSQL 17.11, the existing Supabase session-pool endpoint and unchanged effective `connection_limit=3`.
- Ran one server at a time on reserved local port 3105. Each of anonymous, existing guest-cart-cookie and existing verified-customer profiles received one initial request and eight warm requests. The signed-in profile used an in-memory locally signed session; no user/session/cart/wishlist record was created or changed.
- Collected 27 successful HTTP requests with production debug timings and repeated 27 requests with normal production logging. This is a same-code diagnostic repeat, **not a before/after optimization comparison**. Every request returned 200 and retained twelve product cards and the expected signed-in/anonymous controls.
- Added a temporary diagnostic preload outside application source to observe native engine query/connect intervals, SQL-event durations/fingerprints and process/event-loop measurements. Existing application operation timers were reused. Actual SQL and bound parameters remained in process memory/IPC only, never in logs or result files.
- Captured representative application SELECTs and ran three parameterized `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)` measurements per statement inside a separate `BEGIN READ ONLY` transaction. The transaction ended with `ROLLBACK`; no application rows, schema or persistent settings changed. Sanitized plan shapes retain indexes/row counts but no filter values or customer data.
- Probed DNS/TCP/SSL-request/TLS separately, then tested small `SELECT 1` batches using the existing Prisma pool settings. Diagnostic clients were disconnected between stages, avoiding concurrent diagnostic pools during the HTTP sample sets.

### Every homepage query

The normal warm path contains five public reads. The following table separates normal-production SQL-event exchange time from server-only plan execution. Medians are milliseconds. The event and plan samples were collected in separate stages, so their differences are descriptive rather than exact per-call latency subtraction.

| Application read | Scope and source | SQL-event median | PostgreSQL execution median |
| --- | --- | ---: | ---: |
| Settings | `settings.service.ts:80`; shared layout/footer settings, once per request | 156.0 anonymous | 0.030 |
| Categories/counts | `categories.service.ts:31`; active categories plus published/nondeleted product counts, shared by page/header | 150.5 anonymous | 0.322 |
| Featured products | `products.service.ts:147`; up to 8, rating order, published/active category, joined first image/category/inventory | 153.0 anonymous | 0.543 |
| New arrivals | `products.service.ts:158`; up to 4, creation order, same visibility and bounded joins | 152.0 anonymous | 1.179 |
| Active promotions | `promotions.service.ts:89`; up to 2, current start/end-window filtering | 154.5 anonymous | 0.048 |
| Current user | `auth-guard.ts:17`; request-memoized current database user/role verification, signed in only | 151.0 signed in | 0.037 |
| Wishlist IDs | `wishlist.service.ts:67`; IDs for the verified user, signed in only | 153.5 signed in | 0.044 |
| Cart badge, guest | `cart.service.ts:230`; one joined Cart/CartItem/Product/Inventory read for guest-cookie owner | 164.0 guest | 0.060 |
| Cart badge, user | Same raw read filtered by authenticated user | 143.0 signed in | 0.047 |
| HERO / SIDE banners | `banners.service.ts:11`; two editorial cache miss/revalidation reads, not required on every warm page | Observed on first/expired-cache requests | 0.047 / 0.049 |
| Internal `SELECT 1` | Observed without additional business-query spans; consistent with connection health checks | 148.0, three events in signed-in warm set | Not separately planned; trivial round-trip control measured below |

Counts in the normal sample:

- Anonymous: **5 application SELECTs**, five SQL events on every warm request.
- Guest-cookie owner: **6 application SELECTs**, six SQL events on every warm request.
- Existing signed-in user: **8 application SELECTs**, with **8–10 SQL events** because three extra events across the warm sample were internal `SELECT 1` calls (one request had one, another had two). Their exact SQL shape and lack of extra business-query spans are verified. Connection-health checking is a plausible interpretation, not an independently traced driver call site; the probe's `connection.health-select` label is assigned by SQL shape. No unclassified SQL remained. This is not a product N+1 pattern.
- A banner miss/revalidation adds up to two editorial reads; the first anonymous request in these runs included both.

The selected user/cart data and number of returned rows can affect these results; the private identifiers were not persisted. A deleted or missing session user would have different private-query behavior.

### TTFB, total database work and rendering

Normal production logging; eight warm requests per identity. First-profile requests are excluded from warm statistics.

| Profile | First in profile TTFB | Warm median TTFB | Warm average TTFB | Warm min–max | Median database interval union | Median sum of SQL-event durations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Anonymous | 3,765.56 | 359.84 | 423.01 | 336.19–715.71 | 309.49 | 764.5 |
| Guest cart | 558.53 | 475.58 | 484.86 | 410.45–617.38 | 379.71 | 1,016.0 |
| Signed in | 836.57 | 554.24 | 613.13 | 495.76–810.58 | 492.28 | 1,247.0 |

Only the first anonymous request is the first after process startup. Guest/signed-in first requests use the already-running server. The profile order is fixed; changing network conditions mean cross-profile timing differences are not pure estimates of personalization cost.

**The SQL-duration sum is aggregate work across overlapping requests to the database. It must not be added to TTFB or presented as request wall time.** The interval union counts overlapping native query/connect spans only once. Individual operation spans include client/engine/pool waiting as well as exchange time; exact per-acquisition queue time was not directly observable.

The separate debug run provides the existing page-function timers:

| Profile | Median HTTP TTFB | Median data group | Median page async function | Median database interval union |
| --- | ---: | ---: | ---: | ---: |
| Anonymous | 456.99 | 405.5 | 406.5 | 400.39 |
| Guest cart | 394.97 | 330.0 | 330.5 | 347.07 |
| Signed in | 611.02 | 564.0 | 564.5 | 561.25 |

Guest badge work belongs to the header and can extend beyond the page's data-group timer. The page-function timer includes awaited data and element creation, not every descendant or isolated rendering CPU. The small data-group/page-function differences do not imply that all remaining response time is pure rendering. Debug and normal samples are separate runs with different workload/network conditions; their differences are not proof of logging overhead or an optimization gain.

The maximum observed warm event-loop delays in the normal samples were approximately 17–36 ms. The earlier multi-second development stall was not reproduced in these production requests. Process CPU measurements include native engine work and overlapping activity and are not reported as SSR-only CPU.

### Transport and connection acquisition

Three verified TLS transport probes gave:

| Stage | Median ms | Range ms |
| --- | ---: | ---: |
| DNS lookup | 2.33 | 1.14–11.70 |
| TCP connection after resolved address | 163.87 | 153.89–180.11 |
| PostgreSQL SSL-request round trip | 152.10 | 151.18–154.18 |
| TLS handshake | 220.10 | 200.15–220.26 |
| Total through TLS, before authentication | 540.04 | 517.55–553.46 |

These stages are new-connection measurements, not recurring costs on every warm query. A separate Node PostgreSQL connect including authentication took **1,032.58 ms**. A fresh Prisma `$connect()` took **1,141.73 ms**. The normal production process's native engine initialization/connect span was **1,266.49 ms** on its first request and was not repeated on the following 26 requests. These measurements include multiple components and do not isolate a Supabase backend-slot wait.

Eight warm `SELECT 1` exchanges using a single verified PostgreSQL connection had median **145.37 ms**, average **147.21 ms**, and range **143.71–160.87 ms**. Captured per-statement medians were only **0.03–1.18 ms** for server execution, plus approximately **0.04–0.54 ms** for planning (individual runs reached 1.220 ms execution and 0.557 ms planning). Their client-side EXPLAIN exchanges generally still took approximately 147–163 ms at the median. Together with the independent SSL-request RTT, this is strong evidence that the network/endpoint round-trip path dominates individual warm query exchange latency. It does not precisely split Internet transport from pooler protocol handling or every database-side wait.

The standalone process constructed two native engine objects, but only one connected or executed queries in the audited homepage path. A constructed object is not proof of another active connection pool. No per-request reconnect pattern was observed.

### Pool efficiency

After explicitly warming three connections in a diagnostic Prisma client with the unchanged limit of three (the initial three-query warmup took 1,483.95 ms, before the timed batches):

| Concurrent trivial SELECTs | Batch wall-time range ms | Observed behavior |
| --- | ---: | --- |
| 1 | 161.51–167.21 | One exchange |
| 3 | 154.62–159.95 | All three overlap |
| 6 | 307.26–319.92 | Three finish around 150–164 ms; the next three around 304–320 ms |

This demonstrates actual connection reuse and effective three-way concurrency in the small control test. Excess simultaneous work waits for another exchange wave, as expected for the configured capacity. For example, in the normal anonymous sample, arrivals' median native operation elapsed time was **304.63 ms**, while its median SQL-event exchange was **152 ms**; additional client/pool waiting is consistent with the demonstrated waves, although that difference is not a direct per-operation pool-wait measurement.

Detailed Prisma metrics were unavailable without additional feature configuration. No preview feature/schema change was made to enable them. Global deployment instance/client counts, other applications' usage and remaining Supabase session capacity were not audited. Raising the pool limit is therefore not justified by these observations. [Prisma v6 connection-pool reference](https://docs.prisma.io/docs/orm/v6/prisma-client/setup-and-configuration/databases-connections/connection-pool)

### Query optimization decision

No duplicate identical query, N+1 pattern or sequential independent public query was found. Settings/categories/session/current user remain request-memoized. Featured and arrivals have different predicates/orderings, so their overlapping products do not make the two reads interchangeable. User verification → wishlist is a real dependency and already overlaps public reads. The header waits for layout settings before its private badge read starts; changing that scheduling requires a separate targeted comparison and is not an identified SQL-plan fix.

Small projection opportunities exist (settings' unused `updatedAt`, some shared product metadata and promotion fields). Wishlist reads select only IDs but include the user's entire wishlist; narrowing them to visible products would introduce a catalogue-result dependency and needs evidence of a large payload before changing the current overlap. The plans and approximately 145 ms trivial-query floor do not establish these bytes as a material bottleneck. No speculative projection cleanup, custom SQL batch, larger connection pool, cache of live prices/stock, or schema/index change was implemented.

**Before/after:** application source and SQL are unchanged in this follow-up, so there is no optimization delta to claim. The debug/normal sample sets are diagnostic controls on the same code. The next useful action is to measure the production application host's RTT to this same database endpoint and verify application/database regional placement and connection budgets. Repeat representative signed-in/anonymous p50/p95 traces there before choosing any deployment or connection-management change. No hosting, Supabase or infrastructure change was made here.

### Verification, limitations and preserved work

- Fifty-four HTTP requests in the two completed current-build audit sets returned 200. An earlier partial run also completed its HTTP profiles but stopped at a separate transport verification failure; its figures are retained outside the primary report.
- The initial separate Node PostgreSQL/TLS probe rejected the certificate chain using Node's default roots (`SELF_SIGNED_CERT_IN_CHAIN`). Reusing the machine's existing Node default plus Windows system trust roots made the diagnostic connection pass with certificate verification still enabled. No trust store, application TLS configuration or Supabase setting was changed; verification was never disabled.
- All captured plan statements were SELECT-only and parameterized inside a read-only transaction. No migration, `db push`, destructive SQL, schema modification, application mutation or personal-data cache was used.
- Audit helpers passed `node --check`. Since no application code changed, the 89-test/TypeScript/ESLint/build results above remain the prior verification record; those suites were **not rerun as part of this read-only investigation**. Current HTTP/plan/network checks are the new evidence, not a renewed full-test certification.
- Initial hashes covered 346 existing files. The final preservation check allows only this report's appended section to differ; no existing application/test/configuration file was edited or removed.
- SQL event durations are exchanges, not pure PostgreSQL execution. EXPLAIN execution/planning does not include the complete client/network experience; server output serialization and exact pool acquisition were not independently isolated. [Prisma query-event definition](https://docs.prisma.io/docs/orm/v6/reference/prisma-client-reference), [PostgreSQL 17 EXPLAIN guidance](https://www.postgresql.org/docs/17/using-explain.html)

New audit helpers and outputs are confined to the existing Git-ignored artifact directory: `database-probe.cjs`, `database-latency.mjs`, `query-latency-verified.json`, `query-latency-normal.json`, `query-latency-summary.json` and the source-preservation manifests. Raw SQL/parameters, credentials, endpoint addresses, customer identity and cookies are absent from saved results.
