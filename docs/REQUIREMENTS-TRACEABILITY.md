# Khareedo — Requirements Analysis & Traceability Report

> Source of truth: `khareedo.docx` (updated version supplied by client).
> This report maps every functional (FR-01…FR-51), non-functional (NFR-01…NFR-32) and business-rule
> (BR-01…BR-15) requirement to its implementing module(s) and verification method.

## 1. Confirmed Business Decisions (client-approved defaults)

| # | Decision | Value |
|---|----------|-------|
| D-01 | Guest checkout | **Enabled** |
| D-02 | Initial payment method | **Cash on Delivery (COD)**. Online payments deferred until a provider + credentials exist (FR-23/BR-10 boundary implemented, disabled) |
| D-03 | Delivery fee | Configurable **flat fee per delivery method** (Standard / Express), free-delivery threshold configurable |
| D-04 | Gift wrapping | **One configurable charge per order**, optional, disclosed before confirmation |
| D-05 | Promotions | **Store-managed** promotions, banners, featured products; third-party advertising deferred |
| D-06 | Coupons | Confirmed: percent or fixed-amount codes, min-order value, expiry window, usage limit, entered at checkout |
| D-07 | Currency / locale | **PKR (Rs), English UI** |
| D-08 | Ratings & reviews | **Display-only** ratings (admin-editable product fields); customer review submission deferred |
| D-09 | WhatsApp number | Placeholder, admin-configurable via Store Settings |
| D-10 | Database for sandbox build | Fully functional build on Prisma/SQLite + equivalent **Supabase Postgres migration SQL incl. RLS** shipped in `supabase/migrations/` with setup guide |
| D-11 | Authentication | Working email/password (seeded demo accounts) + **Google-ready** OAuth provider that activates when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are configured |
| D-12 | Product variants | Deferred ("when needed" per doc §7.2); inventory attaches to products |

## 2. Actors

| Actor | Capabilities | Enforcement |
|-------|--------------|-------------|
| Guest | Browse, search, filter, cart, promotions, WhatsApp inquiry, guest checkout | Public routes + server validation |
| Registered customer | Everything guest + profile, addresses, wishlist, order history/tracking | Session-protected routes + ownership checks in services |
| Administrator | Products, categories, inventory, orders, promotions/banners/coupons, gift-wrap & store settings, dashboard & reports | `ADMIN` role checked in proxy (route guard), in every admin API route and in server services |
| External systems | Supabase (DB/Auth/Storage), Google OAuth, WhatsApp, optional payment gateway | Integration boundaries behind typed service interfaces |

## 3. Functional Requirements Traceability

Legend: **Impl** = primary implementing file(s); **Verify** = how it is verified (UT=unit test, IT=integration test, E2E=Playwright/Agent-Browser, M=manual).

### 3.1 Authentication & Accounts
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-01 | Guests browse without logging in | `(store)` routes public, `src/proxy.ts` | E2E |
| FR-02 | Register/sign-in supported | `src/lib/auth.ts`, `/api/register`, `/login`, `/register` | E2E |
| FR-03 | Continue with Google | `GoogleProvider` in `src/lib/auth.ts`, auto-enabled when env keys exist | M (needs keys) |
| FR-04 | Secure sign-out | `signOut()` + cookie clearing | E2E |
| FR-05 | Profile & delivery addresses CRUD | `/account/profile`, `/account/addresses`, `/api/account/*` | E2E |
| FR-06 | Private account data protected | ownership checks in `orders/wishlist/address` services + proxy guard | IT/E2E |

### 3.2 Catalogue & Search
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-07 | Published products & active categories only | `products.service.ts` filters `status=PUBLISHED` + `category.isActive` | UT/IT |
| FR-08 | Product details page | `/product/[slug]`, gallery, price, availability | E2E |
| FR-09 | Keyword search | `products.service.search()` on name/description/brand/tags | IT |
| FR-10 | Category/price filters | `ProductFilters` in services + sidebar UI | E2E |
| FR-11 | Sorting | `sort` param: featured/price-asc/price-desc/rating/newest | IT |
| FR-12 | Promotions & featured products on storefront | `banners`/`promotions` services + homepage sections | E2E |
| FR-13 | Unavailable/unpublished not purchasable | status + stock re-validated in `checkout.service` (BR-04/05) | UT/IT |

### 3.3 Cart
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-14 | Add to cart | `POST /api/cart` + `cart.service.addItem` (guest `sessionKey` cookie or user cart) | E2E |
| FR-15 | Update/remove quantities | `PATCH/DELETE /api/cart` | E2E |
| FR-16 | Subtotal from current valid prices | server-side recalculation in `cart.service` (BR-04) | UT |
| FR-17 | Cart persistence | DB cart keyed by user id or guest session cookie | E2E |
| FR-18 | Availability re-validated at confirmation | `checkout.service.placeOrder` stock check | IT |

### 3.4 Checkout & Orders
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-19 | Collect customer + delivery info | `/checkout` step 1 (guest inline or saved addresses) | E2E |
| FR-20 | Order summary before confirm | `/checkout` review step + summary sidebar | E2E |
| FR-21 | Final amount server-calculated | `pricing.ts` (subtotal, discounts, delivery, gift-wrap, total) | UT/IT |
| FR-22 | COD support | `paymentMethod=COD` + settings toggle | E2E |
| FR-23 | Online payment boundary | `payments` table + disabled toggle + provider interface stub (no fake confirmation) | M |
| FR-24 | Unique order reference | `generateOrderReference()` `KH` + date + random, unique index | UT |
| FR-25 | Order confirmation + status | `/order/[reference]` | E2E |
| FR-26 | Order history for customers | `/account/orders`, `/account/orders/[id]` | E2E |
| FR-27 | No duplicate orders | unique `idempotencyKey` on `orders` + client-generated key per attempt | IT/E2E |

### 3.5 Gift Wrapping
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-28 | Optional gift-wrap at checkout | `/checkout` step 3 toggle | E2E |
| FR-29 | Charge shown before confirmation | summary line in review step (server quote) | E2E |
| FR-30 | Charge per configured rule | `settings.gift_wrap_charge` in `pricing.ts` | UT |
| FR-31 | Option + charge stored with order | `orders.giftWrapSelected/giftWrapCharge` snapshot | IT |
| FR-32 | Admin enable/disable + set charge | `/admin/settings` | E2E |

### 3.6 WhatsApp
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-33 | Contact option in storefront | header top-bar + floating button + footer | E2E |
| FR-34 | Initiate conversation | `wa.me/<number>` deep links | E2E |
| FR-35 | Assisted-order message with product/cart info | `buildWhatsAppMessage()` pre-fills product/cart text | E2E |
| FR-36 | Admin-configurable number | `store_settings.whatsapp_number` | E2E |
| FR-37 | Inquiry ≠ confirmed order | explicit "inquiry only — not an order" labelling in UI copy | M |

### 3.7 Admin Panel
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-38 | Only authorized admins | proxy role guard + per-route `requireAdmin()` | IT/E2E |
| FR-39 | Product lifecycle CRUD | `/admin/products` + `products.admin.service` | E2E |
| FR-40 | Categories/images/prices/inventory | `/admin/categories`, `/admin/inventory`, product form, `/api/admin/upload` | E2E |
| FR-41 | Orders + permitted status updates | `/admin/orders`, status state-machine validation | E2E |
| FR-42 | Promotions, banners, featured | `/admin/promotions`, `/admin/banners`, featured toggle | E2E |
| FR-43 | Gift-wrap settings | `/admin/settings` | E2E |
| FR-44 | Payment options + contact info | `/admin/settings` | E2E |
| FR-45 | Overview (orders, low stock) | `/admin` dashboard cards + low-stock table | E2E |
| FR-46 | Validated changes + feedback | zod validation + toast success/error | E2E |

### 3.8 UX
| ID | Requirement | Impl | Verify |
|----|-------------|------|--------|
| FR-47 | Consistent design system | Tailwind tokens + shadcn/ui, `globals.css` | M |
| FR-48 | Loading/empty/success/error states | skeletons, empty states, sonner toasts | E2E |
| FR-49 | Validation messages | react-hook-form + zod messages | E2E |
| FR-50 | Responsive mobile/tablet/desktop | Tailwind breakpoints throughout | E2E |
| FR-51 | Content changes without code edits | settings/banners/promotions/categories all DB-driven | E2E |

## 4. Non-Functional Requirements Traceability

| ID | Requirement | Implementation / Evidence |
|----|-------------|---------------------------|
| NFR-01 | LCP ≤ 2.5s (p75) | Server components for data pages, `next/image` with sizes, pagination, no client data-fetch on first paint; measured via Agent Browser (see delivery report) |
| NFR-02 | Minimal queries/assets | Service-layer selects only needed columns; indexed FKs; static images |
| NFR-03 | Efficient listings | Pagination (12/page), DB-level filtering, optimized images |
| NFR-04 | Immediate feedback | Optimistic cart badge, toasts, spinners, skeletons |
| NFR-05 | Graceful failures | Error boundaries, friendly messages, no stack traces to customers |
| NFR-06 | No duplicate orders | Idempotency key unique constraint |
| NFR-07 | Order consistency | Single transaction: order + items + stock decrement |
| NFR-08 | Backups | Supabase automated backups documented in deployment guide |
| NFR-09 | Monitoring | Error logging hooks + dev.log in sandbox; Sentry boundary documented |
| NFR-10 | AuthN/AuthZ enforced | proxy + per-route + service-level checks |
| NFR-11 | Customer data isolation | All customer queries scoped by `userId` from session (never from client) |
| NFR-12 | Admin verification | `role=ADMIN` server-side; RLS `is_admin()` SQL in Supabase version |
| NFR-13 | Server-side prices/totals | `pricing.ts` — browser never supplies authoritative amounts |
| NFR-14 | Secrets never in frontend | `NEXT_PUBLIC_*` only for anon-safe values; service keys server-only |
| NFR-15 | HTTPS in production | Deployment guide (Vercel/Supabase) |
| NFR-16 | Rate limiting | checkout/login rate limiter (`lib/rate-limit.ts`, in-memory; Redis boundary documented) |
| NFR-17 | Extensible architecture | service interfaces per domain; category-agnostic catalogue |
| NFR-18 | Reusable components | `components/ui`, `components/products`, `components/layout`… |
| NFR-19 | DB relations/constraints/indexes | Prisma schema + `@@index`; Supabase SQL equivalents |
| NFR-20 | Layer separation | `app` (UI) → `services` (logic) → `lib/db` (data) |
| NFR-21 | Admin-managed content | settings/banners/promotions fully DB-driven |
| NFR-22 | Automated tests | Vitest unit + integration, Playwright e2e suite |
| NFR-23 | Consistent visual system | design tokens in `globals.css` |
| NFR-24 | Mobile/tablet/desktop | responsive layouts verified via Agent Browser |
| NFR-25 | Readable small screens | min touch targets 44px, fluid grids |
| NFR-26 | Accessibility | semantic HTML, labels, focus-visible rings, contrast-checked palette |
| NFR-27 | Content-first, minimal effects | animations limited to feedback transitions |
| NFR-28 | Actionable errors | field-level + form-level messages |
| NFR-29 | Major browsers | standard Next.js/React output |
| NFR-30 | Consistent pricing through checkout | quote → place re-uses same `pricing.ts` |
| NFR-31 | Price/inventory changes don't corrupt orders | order line snapshots (unit price, name, image) |
| NFR-32 | Controlled schema changes | Prisma migrations + `supabase/migrations` versioned SQL |

## 5. Business Rules Traceability

| ID | Rule | Enforcement point |
|----|------|-------------------|
| BR-01 | Guest browsing | public routes |
| BR-02 | Guest checkout contact+delivery required | checkout zod schema |
| BR-03 | Google sign-in | NextAuth Google provider |
| BR-04 | Server uses current prices | `pricing.ts` / `checkout.service` |
| BR-05 | Stock re-validated at submission | `checkout.service.placeOrder` |
| BR-06 | Total = items − discounts + delivery + gift-wrap (+tax if configured) | `pricing.ts` |
| BR-07 | Final amount shown before confirmation | review step renders server quote |
| BR-08 | No duplicate submissions | idempotency key |
| BR-09 | Order preserves prices/delivery details | order snapshots |
| BR-10 | Online orders paid only via verified provider response | payments service (disabled until provider) |
| BR-11 | Cancellation restores stock per status rules | `orders.service.updateStatus` |
| BR-12 | Gift wrap optional + disclosed | checkout UI + quote |
| BR-13 | WhatsApp inquiry ≠ order | UI copy + no order creation from WhatsApp |
| BR-14 | Only admins change catalogue/stock/status/settings | admin guard trio |
| BR-15 | Settings changes don't alter existing orders | snapshot fields on orders |

## 6. Order Status State Machine

```
PENDING → CONFIRMED → PROCESSING → SHIPPED → DELIVERED
   ↘ CANCELLED (from PENDING/CONFIRMED/PROCESSING; restores stock)
```
Payment status: COD → PENDING until DELIVERED (then PAID) or CANCELLED. Online: PENDING until verified provider callback (not implemented until provider chosen).

## 7. Deviations & Proposals (flagged, not silently substituted)

1. **SQLite in sandbox** — client doc mandates Supabase/Postgres. Sandbox has no Supabase credentials, so the build runs on Prisma/SQLite with an identical relational model; **full Postgres migration SQL + RLS policies ship in `supabase/migrations/`** (D-10). Data layer isolated in services so switching is configuration, not rewrite.
2. **Supabase Auth vs NextAuth** — production auth per doc is Supabase Auth; sandbox demo uses NextAuth v4 credentials + Google-ready provider behind `lib/auth` so the interface matches (D-11).
3. **Storage** — production: Supabase Storage. Sandbox: local `public/uploads` via admin upload API with identical service interface.
4. **user_roles table** — implemented as `role` column on `users` (single-role model) for simplicity; Supabase SQL includes `user_roles` table form for multi-role growth.
5. **Reviews** — display-only fields per D-08; mockup's "Reviews" admin page intentionally omitted (no FR backing).
6. **Taxes** — BR-06 includes tax "if required"; no tax policy confirmed → tax fields exist (default 0) but no tax UI; flagged for future confirmation.
