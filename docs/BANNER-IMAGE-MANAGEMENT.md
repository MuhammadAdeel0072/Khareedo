# Banner Image Management — Setup & Operations

This document explains how banner image management works after the UI/UX update,
what (if anything) must be configured on the deployment, and the security model.

## How it works

| Flow | Path | Storage |
| --- | --- | --- |
| Upload from computer | Admin → Banners → Add/Edit → **Upload File** | `POST /api/admin/upload` (multipart, `target=banner`) → Supabase Storage, object key `banners/<uuid>.<ext>` |
| Paste external image URL | **Image URL** tab | Stored as-is (hotlink). Optional **"Download & store permanently"** calls `POST /api/admin/banners/import-image`, which fetches server-side (SSRF-guarded) and stores it under `banners/<uuid>.<ext>` |
| Replace image | Edit dialog → Replace image | Old object is deleted automatically **only if no other banner references it** |
| Delete banner | List → trash icon → confirm | DB row removed; image object cleaned up under the same orphan rule |

Banner records live in the existing `Banner` table (`prisma/schema.prisma`,
`prisma/schema.postgres.prisma`) — **no schema migration is required**. The
storefront reads banners from the database via `getActiveBanners()` and admin
writes call `revalidateTag("storefront-banners")`, so changes appear without
redeploy.

## Environment variables (server-side only)

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co   # already configured
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>             # already configured; never exposed to the client
```

The runtime reuses the **existing `product-images` bucket** (public read) with a
`banners/` key prefix, so **no bucket, policy or schema change is needed** for a
standard Supabase deployment. Uploads, replacement and deletion all run with the
service-role key inside server routes gated by `requireAdmin()` — the key never
reaches the browser.

### Optional: dedicated banner bucket

If you prefer isolating banner objects in their own bucket (e.g. `banner-images`):

1. Create it (dashboard or SQL):

   ```sql
   insert into storage.buckets (id, name, public) values ('banner-images', 'banner-images', true);
   ```

2. Allow public reads (public buckets need no policy for read; uploads happen
   exclusively through the service-role key, so **no client upload policy** is
   required — do not add one).

3. Point the code at it: set the bucket name in `src/lib/storage.ts`
   (`MEDIA_BUCKET`) and add a matching `images.remotePatterns` entry in
   `next.config.ts` only if you render banner images through `next/image`
   (banners deliberately render through a plain `<img>` with a fallback, so this
   is usually unnecessary).

## Security model

- **Admin-only**: `/api/admin/upload` and `/api/admin/banners/*` call
  `requireAdmin()`; roles are re-verified server-side.
- **File validation**: size ≤ 5 MB (request body hard-capped mid-stream), and
  the magic bytes must match JPEG/PNG/WebP/GIF — declared MIME type and file
  name are never trusted. SVG (scriptable) is rejected by design.
- **Collision-resistant object names**: `banners/<uuid>.<ext>`, `upsert: false`,
  so an upload can never overwrite an existing object.
- **SSRF protection on URL import** (`src/lib/ssrf-guard.ts`): only http(s),
  no embedded credentials, DNS resolved and every address checked against
  loopback / private / CGNAT / link-local (incl. `169.254.169.254` cloud
  metadata) / reserved ranges; every redirect hop re-validated (max 3);
  response streamed with a hard 5 MB cap and 10 s timeout; content-type AND
  magic-byte verification; rate-limited to 10 imports per minute per IP.
- **XSS**: banner `imageUrl` and `linkUrl` accept only uploaded/storage URLs,
  root-relative public paths or absolute http(s) URLs — `javascript:`, `data:`,
  `blob:` and protocol-relative references are rejected at validation
  (`bannerSchema`) and again in the admin UI.
- **Orphan-safe cleanup**: an uploaded object is deleted only when no other
  banner row references the same URL; external hotlinks, product images and
  anything outside the `banners/` prefix are never touched; cleanup failures
  are logged and never block the admin operation.

## Storefront rendering notes

- `src/components/home/banner-image.tsx` renders banners through a plain
  `<img>` with `loading="lazy"` (the first hero slide `eager` for LCP),
  `referrerPolicy="no-referrer"` (helps with hotlink-protection on external
  hosts) and an automatic fallback to `/images/placeholder.svg` if an image
  cannot load — a broken external URL can never break the storefront layout.
- Hero carousel and side promos keep their existing layouts/animations; strips
  remain admin-manageable (the storefront did not render strips before this
  change either).

## Verification scripts

```bash
node scripts/diag-checkout-payment.mjs     # payment-method default/switch/persistence
bash scripts/verify-banner-e2e.sh          # upload → create → XSS/SSRF rejection → delete + cleanup
bash scripts/verify-banner-storefront.sh   # storefront visibility + hide-on-inactive lifecycle
node scripts/cwv-probe.mjs                 # Core Web Vitals probe (LCP/CLS/INP/TTFB)
```

(Seed an admin account first — see `scripts/seed.ts`.)
