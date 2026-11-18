-- LEGACY, INCOMPATIBLE WITH THE CURRENT PRISMA/NEXTAUTH MODEL.
-- Do not apply for the SQLite-to-PostgreSQL migration; use prisma/migrations/.
-- ============================================================
-- Khareedo — Row Level Security policies (production Supabase)
-- Run after 0001_schema.sql.
-- Model:
--   • Public (anon): read published catalogue, active banners/promotions only
--   • Authenticated customer: own profile/addresses/orders/wishlist/cart only
--   • Admin (profiles.role = 'ADMIN'): full management access
-- All privileged writes also flow through server-side services (defence in depth).
-- ============================================================

alter table public.profiles        enable row level security;
alter table public.user_roles      enable row level security;
alter table public.addresses       enable row level security;
alter table public.categories      enable row level security;
alter table public.products        enable row level security;
alter table public.product_images  enable row level security;
alter table public.inventory       enable row level security;
alter table public.carts           enable row level security;
alter table public.cart_items      enable row level security;
alter table public.wishlist_items  enable row level security;
alter table public.orders          enable row level security;
alter table public.order_items     enable row level security;
alter table public.payments        enable row level security;
alter table public.promotions      enable row level security;
alter table public.coupons         enable row level security;
alter table public.banners         enable row level security;
alter table public.store_settings  enable row level security;

-- ── profiles ──
create policy "profiles: read own" on public.profiles
  for select using (auth_user_id = auth.uid() or public.is_admin());
create policy "profiles: update own (non-role fields)" on public.profiles
  for update using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid() and role = (select role from public.profiles where auth_user_id = auth.uid()));
create policy "profiles: admin manage" on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- ── user_roles ──
create policy "user_roles: admin only" on public.user_roles
  for all using (public.is_admin()) with check (public.is_admin());
create policy "user_roles: read own" on public.user_roles
  for select using (user_id in (select id from public.profiles where auth_user_id = auth.uid()));

-- ── addresses: strictly own records (NFR-11) ──
create policy "addresses: own crud" on public.addresses
  for all using (
    user_id in (select id from public.profiles where auth_user_id = auth.uid())
  ) with check (
    user_id in (select id from public.profiles where auth_user_id = auth.uid())
  );
create policy "addresses: admin manage" on public.addresses
  for all using (public.is_admin()) with check (public.is_admin());

-- ── categories: public read active; admin manage ──
create policy "categories: public read active" on public.categories
  for select using (is_active = true or public.is_admin());
create policy "categories: admin write" on public.categories
  for all using (public.is_admin()) with check (public.is_admin());

-- ── products: public read published+not-archived; admin full ──
create policy "products: public read published" on public.products
  for select using ((status = 'PUBLISHED' and deleted_at is null) or public.is_admin());
create policy "products: admin write" on public.products
  for all using (public.is_admin()) with check (public.is_admin());

create policy "product_images: public read" on public.product_images
  for select using (
    exists (select 1 from public.products p where p.id = product_id and (p.status = 'PUBLISHED' and p.deleted_at is null))
    or public.is_admin()
  );
create policy "product_images: admin write" on public.product_images
  for all using (public.is_admin()) with check (public.is_admin());

-- ── inventory: admin only (stock levels are not public data) ──
create policy "inventory: admin manage" on public.inventory
  for all using (public.is_admin()) with check (public.is_admin());
-- checkout server (service role) bypasses RLS to call inventory_reserve()

-- ── carts & cart items: owner or guest session (session-key carts are written
--    by the server for anon visitors; anon inserts blocked, server uses service role)
create policy "carts: owner access" on public.carts
  for all using (
    user_id in (select id from public.profiles where auth_user_id = auth.uid())
    or public.is_admin()
  ) with check (
    user_id in (select id from public.profiles where auth_user_id = auth.uid())
    or public.is_admin()
  );
create policy "cart_items: owner access" on public.cart_items
  for all using (
    cart_id in (
      select c.id from public.carts c
      where c.user_id in (select id from public.profiles where auth_user_id = auth.uid())
    )
    or public.is_admin()
  ) with check (
    cart_id in (
      select c.id from public.carts c
      where c.user_id in (select id from public.profiles where auth_user_id = auth.uid())
    )
    or public.is_admin()
  );

-- ── wishlist: owner only ──
create policy "wishlist: owner crud" on public.wishlist_items
  for all using (
    user_id in (select id from public.profiles where auth_user_id = auth.uid())
  ) with check (
    user_id in (select id from public.profiles where auth_user_id = auth.uid())
  );

-- ── orders: customers see only their own; guests created server-side (NFR-11) ──
create policy "orders: read own" on public.orders
  for select using (
    user_id in (select id from public.profiles where auth_user_id = auth.uid())
    or public.is_admin()
  );
create policy "orders: admin manage" on public.orders
  for all using (public.is_admin()) with check (public.is_admin());
-- inserts happen via trusted server code (service role key), never from the browser

create policy "order_items: read own" on public.order_items
  for select using (
    order_id in (
      select o.id from public.orders o
      where o.user_id in (select id from public.profiles where auth_user_id = auth.uid())
    )
    or public.is_admin()
  );
create policy "order_items: admin write" on public.order_items
  for all using (public.is_admin()) with check (public.is_admin());

create policy "payments: read own" on public.payments
  for select using (
    order_id in (
      select o.id from public.orders o
      where o.user_id in (select id from public.profiles where auth_user_id = auth.uid())
    )
    or public.is_admin()
  );
create policy "payments: admin write" on public.payments
  for all using (public.is_admin()) with check (public.is_admin());

-- ── marketing: public reads actives; admin manages ──
create policy "promotions: public read active" on public.promotions
  for select using (is_active = true or public.is_admin());
create policy "promotions: admin write" on public.promotions
  for all using (public.is_admin()) with check (public.is_admin());

create policy "coupons: admin only" on public.coupons
  for all using (public.is_admin()) with check (public.is_admin());
-- coupon VALIDATION for checkout runs server-side with the service role

create policy "banners: public read active" on public.banners
  for select using (is_active = true or public.is_admin());
create policy "banners: admin write" on public.banners
  for all using (public.is_admin()) with check (public.is_admin());

-- ── store settings: public read (values are non-sensitive), admin write ──
create policy "settings: public read" on public.store_settings
  for select using (true);
create policy "settings: admin write" on public.store_settings
  for all using (public.is_admin()) with check (public.is_admin());
