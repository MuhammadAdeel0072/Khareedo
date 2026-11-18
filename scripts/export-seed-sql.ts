/**
 * Export live catalog data → supabase/migrations/seed.sql (Postgres demo seed).
 * Reads via Prisma, emits idempotent SQL keyed on natural keys (slug/email/sku).
 *
 * Catalog and settings ONLY. This exporter never exports accounts, password
 * hashes, or addresses: SQL seeds must never provision login accounts (see
 * docs/SEEDING.md). Accounts are created through registration or the guarded
 * `scripts/seed.ts`, with operator-chosen passwords.
 *
 * Reads the database configured by SUPABASE_POSTGRES_URL (the application
 * database) — it never writes to it.
 */
import { db } from '../src/lib/db';
import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

function q(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const lines: string[] = [];
  lines.push(`-- ============================================================`);
  lines.push(`-- Khareedo — Supabase demo seed (OPTIONAL)`);
  lines.push(`-- Run AFTER 0001_schema.sql and 0002_rls.sql (Supabase SQL Editor).`);
  lines.push(`-- Idempotent: uses ON CONFLICT on natural keys (slug / email / key).`);
  lines.push(`-- Catalog and settings only: this file never creates accounts.`);
  lines.push(`-- ============================================================`);
  lines.push(``);

  // ── Store settings ──────────────────────────────────────────
  const settings = await db.storeSetting.findMany({ orderBy: { key: 'asc' } });
  lines.push(`-- ── Store settings ──`);
  for (const s of settings) {
    lines.push(
      `insert into public.store_settings (key, value, updated_at) values (${q(s.key)}, ${q(s.value)}, now()) on conflict (key) do update set value = excluded.value;`
    );
  }
  lines.push(``);

  // ── Categories (parents first, then children) ───────────────
  const categories = await db.category.findMany({ orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }] });
  const parents = categories.filter((c) => !c.parentId);
  const children = categories.filter((c) => c.parentId);
  lines.push(`-- ── Categories (2-level) ──`);
  for (const c of parents) {
    lines.push(
      `insert into public.categories (name, slug, description, image_url, parent_id, is_active, sort_order) values (${q(c.name)}, ${q(c.slug)}, ${q(c.description)}, ${q(c.imageUrl)}, null, ${c.isActive}, ${c.sortOrder}) on conflict (slug) do nothing;`
    );
  }
  for (const c of children) {
    const parentSlug = parents.find((p) => p.id === c.parentId)?.slug;
    if (!parentSlug) continue;
    lines.push(
      `insert into public.categories (name, slug, description, image_url, parent_id, is_active, sort_order) values (${q(c.name)}, ${q(c.slug)}, ${q(c.description)}, ${q(c.imageUrl)}, (select id from public.categories where slug = ${q(parentSlug)}), ${c.isActive}, ${c.sortOrder}) on conflict (slug) do nothing;`
    );
  }
  lines.push(``);

  // ── Products + images + inventory ───────────────────────────
  const products = await db.product.findMany({
    include: { images: true, inventory: true },
    orderBy: { slug: 'asc' },
  });
  lines.push(`-- ── Products (51) ──`);
  for (const p of products) {
    const catSlug = categories.find((c) => c.id === p.categoryId)?.slug;
    lines.push(
      `insert into public.products (name, slug, description, brand, sku, category_id, price, compare_price, status, is_featured, rating, review_count, tags, created_at, updated_at) values (${q(p.name)}, ${q(p.slug)}, ${q(p.description)}, ${q(p.brand)}, ${q(p.sku)}, (select id from public.categories where slug = ${q(catSlug)}), ${p.price}, ${p.comparePrice}, ${q(p.status)}, ${p.isFeatured}, ${p.rating ?? 0}, ${p.reviewCount ?? 0}, ${q(p.tags ?? null)}, now(), now()) on conflict (slug) do nothing;`
    );
  }
  lines.push(``);
  lines.push(`-- ── Product images ──`);
  for (const p of products) {
    for (const img of p.images) {
      lines.push(
        `insert into public.product_images (product_id, url, alt, sort_order) values ((select id from public.products where slug = ${q(p.slug)}), ${q(img.url)}, ${q(img.alt)}, ${img.sortOrder}) on conflict do nothing;`
      );
    }
  }
  lines.push(``);
  lines.push(`-- ── Inventory (one row per product) ──`);
  for (const p of products) {
    if (!p.inventory) continue;
    lines.push(
      `insert into public.inventory (product_id, quantity, low_stock_threshold) values ((select id from public.products where slug = ${q(p.slug)}), ${p.inventory.quantity}, ${p.inventory.lowStockThreshold}) on conflict (product_id) do update set quantity = excluded.quantity;`
    );
  }
  lines.push(``);

  // ── Banners ─────────────────────────────────────────────────
  const banners = await db.banner.findMany({ orderBy: { sortOrder: 'asc' } });
  lines.push(`-- ── Banners ──`);
  for (const b of banners) {
    lines.push(
      `insert into public.banners (title, subtitle, image_url, link_url, placement, is_active, sort_order) values (${q(b.title)}, ${q(b.subtitle)}, ${q(b.imageUrl)}, ${q(b.linkUrl)}, ${q(b.placement)}, ${b.isActive}, ${b.sortOrder});`
    );
  }
  lines.push(``);

  // ── Coupons + promotion ─────────────────────────────────────
  const coupons = await db.coupon.findMany();
  lines.push(`-- ── Coupons ──`);
  for (const c of coupons) {
    lines.push(
      `insert into public.coupons (code, description, type, value, min_order_amount, starts_at, expires_at, max_uses, used_count, is_active) values (${q(c.code)}, ${q(c.description)}, ${q(c.type)}, ${c.value}, ${c.minOrderAmount}, ${q(c.startsAt)}, ${q(c.expiresAt)}, ${c.maxUses}, ${c.usedCount}, ${c.isActive}) on conflict (code) do nothing;`
    );
  }
  const promos = await db.promotion.findMany();
  lines.push(``);
  lines.push(`-- ── Promotions ──`);
  for (const pr of promos) {
    lines.push(
      `insert into public.promotions (title, description, type, value, min_order_amount, starts_at, ends_at, is_active) values (${q(pr.title)}, ${q(pr.description)}, ${q(pr.type)}, ${pr.value}, ${pr.minOrderAmount}, ${q(pr.startsAt)}, ${q(pr.endsAt)}, ${pr.isActive});`
    );
  }
  lines.push(``);

  // No accounts are exported here on purpose: a SQL seed must never
  // provision login accounts or carry password hashes (see docs/SEEDING.md).
  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations', 'seed.sql');
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log('seed.sql written:', lines.length, 'lines');
}

main().finally(() => db.$disconnect());
