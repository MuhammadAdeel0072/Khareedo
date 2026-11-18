-- LEGACY, INCOMPATIBLE WITH THE CURRENT PRISMA/NEXTAUTH MODEL.
-- Do not apply for the SQLite-to-PostgreSQL migration; use prisma/migrations/.
-- ============================================================
-- Khareedo — Supabase/PostgreSQL schema (production)
-- Mirrors prisma/schema.prisma. Run in Supabase SQL Editor in order:
--   0001_schema.sql → 0002_rls.sql → seed.sql (optional demo data)
-- Money columns are INTEGER PKR (whole rupees).
-- ============================================================

create extension if not exists "pgcrypto";

-- ───────────────── Users & auth ─────────────────
-- NOTE: passwords/identities live in Supabase Auth (auth.users).
-- public.profiles mirrors auth users; id = auth.users.id.

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  email text not null unique,
  password_hash text,                       -- null when using OAuth-only (managed by Supabase Auth in production)
  name text,
  phone text,
  image text,
  role text not null default 'CUSTOMER' check (role in ('CUSTOMER','ADMIN')),
  email_verified timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Multi-role growth path (doc §7.2): current role kept on profiles.role
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('CUSTOMER','ADMIN')),
  assigned_at timestamptz not null default now(),
  unique (user_id, role)
);

create table if not exists public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  label text not null default 'Home',
  full_name text not null,
  phone text not null,
  line1 text not null,
  line2 text,
  city text not null,
  province text not null,
  postal_code text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists addresses_user_idx on public.addresses(user_id);

-- ───────────────── Catalogue ─────────────────
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  image_url text,
  parent_id uuid references public.categories(id) on delete set null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists categories_parent_idx on public.categories(parent_id);
create index if not exists categories_active_idx on public.categories(is_active);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text not null default '',
  brand text,
  sku text unique,
  category_id uuid not null references public.categories(id),
  price integer not null check (price >= 0),
  compare_price integer check (compare_price >= 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','ARCHIVED')),
  is_featured boolean not null default false,
  rating double precision not null default 0,
  review_count integer not null default 0,
  tags text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_status_idx on public.products(status);
create index if not exists products_featured_idx on public.products(is_featured);
create index if not exists products_price_idx on public.products(price);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  url text not null,
  alt text,
  sort_order integer not null default 0
);
create index if not exists product_images_product_idx on public.product_images(product_id);

create table if not exists public.inventory (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null unique references public.products(id) on delete cascade,
  -- DB-level guarantee stock can never go negative (BR-05, NFR-07)
  quantity integer not null default 0 check (quantity >= 0),
  low_stock_threshold integer not null default 5,
  updated_at timestamptz not null default now()
);
create index if not exists inventory_quantity_idx on public.inventory(quantity);

create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references public.profiles(id) on delete cascade,
  session_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  gift_wrap boolean not null default false,
  unique (cart_id, product_id)
);
create index if not exists cart_items_cart_idx on public.cart_items(cart_id);

create table if not exists public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, product_id)
);
create index if not exists wishlist_user_idx on public.wishlist_items(user_id);

-- ───────────────── Orders ─────────────────
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  -- one order per checkout attempt (FR-27, BR-08)
  idempotency_key text not null unique,
  user_id uuid references public.profiles(id) on delete set null,
  is_guest boolean not null default false,
  -- customer snapshot (BR-09)
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  -- delivery address snapshot (BR-09, BR-15)
  ship_full_name text not null,
  ship_phone text not null,
  ship_line1 text not null,
  ship_line2 text,
  ship_city text not null,
  ship_province text not null,
  ship_postal_code text,
  status text not null default 'PENDING'
    check (status in ('PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED')),
  payment_method text not null default 'COD' check (payment_method in ('COD','BANK_TRANSFER','ONLINE')),
  payment_status text not null default 'PENDING' check (payment_status in ('PENDING','PAID','FAILED','REFUNDED')),
  -- money snapshots, INTEGER PKR (BR-04/06/15)
  subtotal integer not null,
  discount_total integer not null default 0,
  delivery_fee integer not null default 0,
  delivery_method text not null default 'STANDARD' check (delivery_method in ('STANDARD','EXPRESS')),
  gift_wrap_charge integer not null default 0,
  tax_total integer not null default 0,
  total integer not null check (total >= 0),
  gift_wrap_selected boolean not null default false,
  gift_wrap_message text,
  coupon_code text,
  coupon_title text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_user_idx on public.orders(user_id);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_created_idx on public.orders(created_at desc);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  -- line snapshots survive product edits/archival (NFR-31)
  product_name text not null,
  product_slug text not null,
  image_url text,
  unit_price integer not null,
  quantity integer not null check (quantity > 0),
  line_total integer not null,
  gift_wrap boolean not null default false
);
create index if not exists order_items_order_idx on public.order_items(order_id);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  provider text not null,
  amount integer not null,
  status text not null default 'PENDING' check (status in ('PENDING','PAID','FAILED','REFUNDED')),
  -- BR-10: reference is set ONLY from verified provider responses
  reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payments_order_idx on public.payments(order_id);

-- ───────────────── Marketing ─────────────────
create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  type text not null default 'PERCENT' check (type in ('PERCENT','FIXED')),
  value integer not null check (value > 0),
  min_order_amount integer,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text,
  type text not null default 'PERCENT' check (type in ('PERCENT','FIXED')),
  value integer not null check (value > 0),
  min_order_amount integer not null default 0,
  max_uses integer,
  used_count integer not null default 0,
  starts_at timestamptz,
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists coupons_active_idx on public.coupons(is_active);

create table if not exists public.banners (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subtitle text,
  image_url text not null,
  link_url text,
  placement text not null default 'HERO' check (placement in ('HERO','SIDE','STRIP')),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists banners_placement_idx on public.banners(placement, is_active);

-- ───────────────── Settings ─────────────────
create table if not exists public.store_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- ───────────────── Concurrency-safe stock helpers ─────────────────
-- Atomic, race-free stock decrement used by checkout (two customers can never
-- buy the same last unit). Returns false when stock is insufficient.

create or replace function public.inventory_reserve(p_product_id uuid, p_qty integer)
returns boolean language plpgsql as $$
declare
  updated int;
begin
  update public.inventory
     set quantity = quantity - p_qty,
         updated_at = now()
   where product_id = p_product_id
     and quantity >= p_qty;
  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

create or replace function public.inventory_restore(p_product_id uuid, p_qty integer)
returns void language plpgsql as $$
begin
  update public.inventory
     set quantity = quantity + p_qty,
         updated_at = now()
   where product_id = p_product_id;
end;
$$;

-- ───────────────── Admin helper for RLS ─────────────────
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.auth_user_id = auth.uid() and p.role = 'ADMIN'
  );
$$;
