# Khareedo — Implementation Report (Tasks 1–5)

Date: 14 November 2026 (Asia/Karachi). Branch: `feature/client-ux-dynamic-banners-performance`, cut from `main` @ `fd44e2d`. **Nothing is committed or pushed yet** — the working tree holds the complete implementation and awaits explicit approval (then: push branch → PR → merge only after PR approval).

---

## A. GitHub / change inventory

Base: `main` @ `fd44e2d` ("fix(safepay): secure refund ledger database permissions"). Working tree (uncommitted):

| Status | File | Purpose |
| --- | --- | --- |
| M | `src/components/checkout/checkout-flow.tsx` | Task 1 — payment step selection logic |
| M | `src/app/admin/(panel)/orders/page.tsx` | Task 2 — URL-driven filters, All-reset, chips |
| M | `src/services/orders.service.ts` | Task 2 — shared case-insensitive WHERE builder |
| M | `src/app/api/admin/export/route.ts`, `src/services/export.service.ts`, `src/components/admin/export-buttons.tsx` | Task 2 — exports follow the list's filter scope |
| M | `src/components/admin/banners-manager.tsx` | Task 3 — Upload/URL modal, drag-drop, progress |
| M | `src/services/banners.service.ts` | Task 3 — orphan-safe storage cleanup |
| M | `src/lib/validation.ts` | Task 3 — http(s)/path-only banner URL rules |
| M | `src/app/api/admin/upload/route.ts` | Task 3 — `target=banner` namespaced uploads |
| A | `src/app/api/admin/banners/import-image/route.ts` | Task 3 — SSRF-guarded "download & store permanently" |
| A | `src/lib/storage.ts` | Task 3 — single Supabase Storage helper |
| A | `src/components/home/banner-image.tsx` | Task 3 — storefront banner renderer with fallback |
| A | `src/lib/payment-defaults.ts` | Task 1 — pure eligibility/default helpers |
| A | `src/lib/ssrf-guard.ts` | Task 3 — DNS-resolved private-range blocking |
| A | `tests/unit/payment-defaults.test.ts`, `banner-url-safety.test.ts`, `ssrf-guard.test.ts`, `banner-storage-cleanup.test.ts` | New unit coverage |
| M | `tests/unit/integration.orders.test.ts` | Task 2 — admin search/filter integration tests |
| A | `docs/BANNER-IMAGE-MANAGEMENT.md` | Task 3 — ops & security documentation |
| A | `scripts/cwv-probe.mjs`, `scripts/diag-checkout-payment.mjs`, `scripts/verify-banner-e2e.sh`, `scripts/verify-banner-storefront.sh` | Repeatable verification tooling |
| M | `src/lib/db.ts` | loopback-host TLS exception (local preview only) |
| M | `next.config.ts` | optional `/storage` rewrite for sandbox previews (unset in production) |
| M | `src/app/(store)/page.tsx`, `src/components/home/hero-carousel.tsx` | Task 3 — dynamic banner rendering |

Totals: 15 modified + 12 new files, ~+800 / −105 lines.

## B. Root causes and fixes

**Task 1 — checkout payment step.** Root causes: (1) each option's radio carried `value={title}` plus its own `onClick` handler *inside* a `<label>` without `htmlFor` — one physical click activated both the label-default-radio behaviour and the explicit handler, and Radix also fired `onValueChange`, so the controlled value was written twice per click (the reported "need two clicks" race); (2) the default was computed once from config at mount with no eligibility model; (3) no persistence rule across steps. Fix: single authoritative `paymentMethod` state written only by the group's `onValueChange`; label `htmlFor`/`id` association so the whole card is one click (mouse, touch, keyboard via Radix arrow navigation); pure helpers (`availablePaymentMethods`, `defaultPaymentMethod`) pre-select the first eligible method (COD preferred); render-time state adjustment resets the selection only when it becomes invalid; "Review Order" is disabled and an explanatory alert renders when nothing is eligible. Server-side method re-validation in checkout.service is untouched.

**Task 2 — admin orders search/filter.** Root cause: the page's `buildUrl` unconditionally carried the current `q` into every tab link (`if (q) sp.set("q", q)` before overrides), so "All" re-applied the search instead of clearing it; status tabs also inherited the search silently. Search matched case-sensitively on PostgreSQL (`contains` → `LIKE`). Fix: URL is the single source of truth built from explicit parts only — "All" links to bare `/admin/orders` (clears q, status, page), status tabs reset to page 1, search spans reference/name/email/phone case-insensitively (`mode: "insensitive"` on PostgreSQL; the disposable SQLite harness keeps its native ASCII-insensitive LIKE), an active search renders as a removable chip, the empty state offers a one-click reset, the counter line names the active scope, and order exports accept the same `q`/`status` scope so downloads match the list. Debounce/stale-response safety: the list is a server component reading `searchParams`, so each navigation is one authoritative request — no client-side response races exist.

**Task 3 — dynamic banner management.** Root cause: admins had to hand-paste storage paths or code changes to change homepage imagery. Fix: modal with "Upload File" (recommended default) / "Image URL" tabs; uploads stream via XHR with progress to the existing admin upload API (`target=banner` → `banners/<uuid>.<ext>` in the existing Supabase `product-images` bucket, magic-byte-verified, ≤5 MB, SVG rejected, collision-resistant keys, upsert disabled); external URLs are validated (http(s) or site-root paths only) and can be hotlinked or permanently imported server-side through the SSRF-guarded import endpoint (DNS-resolved private/loopback/CGNAT/link-local/metadata blocking, per-redirect re-validation ≤3 hops, streaming size cap, magic-byte check); replacement/deletion clean up the old object only when no other banner references it and cleanup failure never blocks the DB write; admin writes call `revalidateTag("storefront-banners")` so the storefront updates instantly without redeploy; the storefront renders banners through `BannerImage` (plain `<img>` with placeholder fallback, first hero eager for LCP, rest lazy) preserving the original carousel/side layouts and animations. `STRIP` remains admin-manageable exactly as before (the original storefront never rendered strips — behaviour preserved).

## C. UI/UX standardization (HCI audit → fixes, no redesign)

Consistent with the existing green/cream design system: labelled inputs with `htmlFor`/`id`, `role="tablist"/"tab"`, `role="radiogroup"`, `role="alert"` validation, `role="search"`, `aria-label`/`aria-selected`/`aria-invalid`/`aria-hidden` on decorative icons; visible `:focus-visible` rings; keyboard operability (Enter/Space opens the file picker, arrows move the radio group, dialog focus trap via Radix); informative empty states with recovery actions; disabled states that explain ("Coming soon", "No payment method available"); human-readable error copy for uploads/imports; placement-specific size hints; destructive delete still behind a confirmation dialog. Automated a11y probe (lang, labels, alts, heading order, focus visibility) passes on `/`, `/products`, `/login`, `/cart`; admin pages verified interactively (login, orders, banners, products).

## D. Performance

Context: `main` already carries prior engineering (hot-path indexes, connection cache, cached display settings, parallel typed homepage reads — see `docs/PERFORMANCE-ENGINEERING.md`, `HOMEPAGE-PERFORMANCE-2026-11-04.md`; documented warm Supabase production TTFB ≈ 683→644 ms, cold ≈ 5–6 s). This pass adds no new hot-path queries: banner reads stay behind the existing `unstable_cache`, the orders search narrows the existing query with an insensitive `contains` (same index profile), and exports are bounded by the previous `take`.

A/B on the identical local production stack (standalone build, local PostgreSQL, n=7 route medians / 3-run CWV medians; absolute numbers reflect the local DB, not Supabase latency):

| Route | TTFB before → after | LCP before → after | CLS before → after |
| --- | --- | --- | --- |
| `/` | 23 ms → 24 ms | 232 ms → 228–308 ms (noise) | 0 → 0 |
| `/products` | 24 ms → 21 ms | 232 ms → 208 ms | 0.0054 → 0 |
| `/product/…` | 30 ms → 29 ms | 192 ms → 180 ms | 0 → 0 |
| `/categories` | 22 ms → 19 ms | 160 ms → 156 ms | 0 → 0 |
| `/admin/orders` | 12 ms → 11 ms | — | — |
| `/admin/banners` | 9 ms → 9 ms | — | — |

All Core Web Vitals sit far inside the targets (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1). Remaining known items: cold-start cost (previously documented, unchanged scope), `/products` transient 0.0054 CLS on first paint (well under threshold), and the two pre-existing SQLite-harness concurrency test failures below.

## E. Database

Runtime remains **Supabase PostgreSQL only**: `SUPABASE_POSTGRES_URL` → `src/lib/db.ts` → `generated/postgres-client` (`prisma/schema.postgres.prisma`). All four migrations, including `20261110000000_safepay_refund_ledger`, are intact and untouched; no reset, rewrite or destructive sync was run. Banner management needs **no schema migration** (existing `Banner` table). The only `db.ts` change is a loopback-host exception to `sslmode` so the local preview PostgreSQL (no TLS layer) can run; every non-loopback host — including all Supabase hosts — keeps `verify-full`. The SQLite setup exists solely inside the disposable test harness (`KHAREEDO_DISPOSABLE_SQLITE_TEST=1`).

## F. Security

- No credentials printed or persisted; `.env` untracked; service-role key stays server-side (`import "server-only"` in `storage.ts`).
- All upload/import/banner mutation routes are `requireAdmin()`-gated with existing rate limiting (import: 10/min/IP).
- File safety: magic-byte verification (JPEG/PNG/WebP/GIF), 5 MB cap enforced mid-stream, SVG rejected by design.
- SSRF: external imports resolve DNS and block loopback/private/CGNAT/link-local (incl. cloud metadata)/reserved ranges; every redirect hop re-validated; live-tested — metadata-IP import returns `IMPORT_BLOCKED`.
- XSS: `javascript:`/`data:`/protocol-relative destinations rejected by both zod validation and the admin UI; live-tested.
- Safepay surface untouched: no diff in session creation, webhook verification, refunds, reconciliation, idempotency or server-side totals; sandbox-only payment remains enabled and production payment stays disabled ("DISABLED" badge verified in UI).

## G. Verification (exact results)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS (0 errors) |
| `npm run build` (Postgres client generate + Next build) | PASS |
| `npm run lint` | 0 errors; 1 pre-existing warning (`admin-login-form.tsx`, present on unmodified `main`) |
| `npm run test:db` | 252/254 PASS; the 2 failures are pre-existing on unmodified `main` (SQLite-harness write-concurrency limits in `integration.payment-settlement` / `integration.safepay-webhook` "serializes…/concurrent duplicate" cases — the code paths map those Prisma error codes to retryable `BUSY` on PostgreSQL, which is the production engine) |
| `git diff --check` | clean |
| Payment default selection (COD) on entering step | PASS (live Playwright) |
| Exactly-one-click switch COD → Bank Transfer | PASS |
| Selection persists across step round-trip | PASS |
| Admin "All" clears search+status+page, URL `/admin/orders?q=KH` → `/admin/orders`, input emptied, counter restored | PASS |
| Banner upload → create → storefront visible immediately | PASS (`revalidateTag` verified live) |
| Banner delete → storefront removal + storage object gone (HTTP 400 on public URL) | PASS |
| External URL banner (hotlink save) | PASS |
| External URL → server-side permanent import | PASS (`imported:true`, object stored under `banners/…jpg`) |
| `javascript:` URL rejected / metadata-IP import blocked | PASS / PASS |
| Admin UI render (banners modal tabs, drag-drop zone, hints) | PASS (screenshots) |
| a11y probe on 4 public pages | ALL PASS |
| Mobile 390 px render | PASS (screenshot) |

## H. Delivery

- **Preview**: production build running at port 3000 in this sandbox (start anytime with `scripts/start-preview.sh`; seed data via `scripts/seed.ts` — admin `admin@khareedo.pk` / customer `ali.hassan@example.com`, seeded passwords as in the repo script). Screenshots captured of the storefront, mobile home, admin banners dialog, checkout payment step.
- **Deployment prerequisites**: none new. Reuses the existing Supabase `product-images` bucket with a `banners/` key prefix (public read; service-role writes only). Optional dedicated-bucket instructions in `docs/BANNER-IMAGE-MANAGEMENT.md`. The `next.config.ts` rewrite activates only when `LOCAL_STORAGE_PROXY_URL` is set (sandbox previews); production is unaffected.
- **Limitations / notes**: local A/B numbers cannot represent Supabase network latency (see §D context); STRIP banners remain admin-managed but unrendered on the storefront (original behaviour); banner objects in mock/local storage for previews are not production data.
- **Awaiting approval**: on explicit approval — commit the working tree (proposed: `feat(ux): checkout payment selection, admin orders search reset, dynamic banner management, a11y and perf verification`), push the branch, open a PR against `main`; merge only after PR review approval.
