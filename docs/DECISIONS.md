# Khareedo — Implementation Decisions & Unresolved Items

## Approved decisions (this build)
See `docs/REQUIREMENTS-TRACEABILITY.md` §1 (D-01 … D-12).

## Proposed defaults embedded in the build (labelled proposals)
| Topic | Proposal shipped | Where to change |
|-------|------------------|-----------------|
| Delivery methods | Standard (Rs 200, free ≥ Rs 3,000) & Express (Rs 400) — both admin-editable flat fees | Admin → Settings |
| Gift wrap | Single per-order charge Rs 150, toggleable | Admin → Settings |
| Free-delivery threshold | Rs 3,000 (matches mockups) | Admin → Settings |
| Order statuses | PENDING → CONFIRMED → PROCESSING → SHIPPED → DELIVERED (+ CANCELLED) | `lib/constants.ts` |
| COD settlement | COD orders marked PAID when admin sets DELIVERED | `orders.service` |
| Pagination | 12 products/page storefront, 15 rows/page admin | service params |

## Unresolved / requiring client input before production
1. **Payment gateway** — provider not selected. `payments` table + disabled toggle implemented; no gateway code, no fake confirmations. Provide provider + API keys to enable.
2. **Google OAuth credentials** — create an OAuth client (Google Cloud Console) and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; the Continue-with-Google button activates automatically.
3. **WhatsApp number** — placeholder `+92 300 1234567` until the real number is set in Admin → Settings.
4. **Tax policy** — not confirmed; fields reserved, zero-rated.
5. **Third-party advertising** — deferred per defaults.
6. **Product variants** — deferred ("when needed"); schema extension point documented.
7. **Supabase project** — create project → run `supabase/migrations/*.sql` → set env vars (see `docs/SUPABASE-SETUP.md`).
