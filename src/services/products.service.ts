// Product catalogue service — storefront reads (FR-07..13) + admin CRUD (FR-39/40).
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import { writeAvailableStock } from "@/services/reservation-writes";
import { cleanupOrphanedMediaImage } from "@/services/media-cleanup.service";
import { getCategorySubtreeSlugs } from "@/services/categories.service";
import { totalProductStock, inventoryForVariant, assertVariantSkuFree, VariantSkuConflictError, type VariantDetail } from "@/services/variants.service";
import { type ProductSort } from "@/lib/constants";
import { slugify } from "@/lib/utils";
import { withPerformanceTiming } from "@/lib/performance-timing";

/** Creating/updating a product into an inactive category. The API routes
 *  map this to a 422 with a clear message; the import flow surfaces it as
 *  a per-row issue. */
export class InactiveCategoryError extends Error {
  constructor(
    message: string,
    public readonly categoryId: string,
  ) {
    super(message);
    this.name = "InactiveCategoryError";
  }
}

/** Guard shared by create/update (and the import flow, which calls the
 *  service directly): a product must never land in an inactive category,
 *  or it silently disappears from the storefront. Runs inside the write
 *  transaction so a concurrent deactivation cannot slip between check
 *  and write. The transaction client is typed structurally: the app's db
 *  is an extended Prisma client, whose transaction type is not
 *  Prisma.TransactionClient. */
async function assertCategoryActive(
  tx: {
    category: {
      findUnique: (args: {
        where: { id: string };
        select: { isActive: true };
      }) => Promise<{ isActive: boolean } | null>;
    };
  },
  categoryId: string,
): Promise<void> {
  const category = await tx.category.findUnique({
    where: { id: categoryId },
    select: { isActive: true },
  });
  if (category && category.isActive === false) {
    throw new InactiveCategoryError(
      "The selected category is inactive. Choose an active category or reactivate it first.",
      categoryId,
    );
  }
}

export interface ProductFilters {
  q?: string; // keyword search (FR-09)
  category?: string; // category slug — includes child categories (FR-10)
  brand?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: ProductSort; // FR-11
  page?: number;
  perPage?: number;
  featured?: boolean;
  inStockOnly?: boolean;
}

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  price: number;
  comparePrice: number | null;
  brand: string | null;
  rating: number;
  reviewCount: number;
  image: string | null;
  stock: number;
  isFeatured: boolean;
  status: string;
  createdAt: Date;
  categoryName: string;
  categorySlug: string;
}

const listSelect = {
  id: true,
  name: true,
  slug: true,
  price: true,
  comparePrice: true,
  brand: true,
  rating: true,
  reviewCount: true,
  status: true,
  isFeatured: true,
  createdAt: true,
  category: { select: { name: true, slug: true } },
  images: { take: 1, orderBy: { sortOrder: "asc" as const }, select: { url: true } },
  inventory: { select: { variantId: true, quantity: true } },
} satisfies Prisma.ProductSelect;

type ListRow = Prisma.ProductGetPayload<{ select: typeof listSelect }>;

function toListItem(p: ListRow): ProductListItem {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    price: p.price,
    comparePrice: p.comparePrice,
    brand: p.brand,
    rating: p.rating,
    reviewCount: p.reviewCount,
    image: p.images[0]?.url ?? null,
    // Total available stock across the product-level row and every variant
    // row (Chunk 8 — D12): a variant product is purchasable while any of
    // its rows has stock. Per-variant availability lives on the PDP.
    stock: totalProductStock(p.inventory),
    isFeatured: p.isFeatured,
    status: p.status,
    createdAt: p.createdAt,
    categoryName: p.category.name,
    categorySlug: p.category.slug,
  };
}

// Case-insensitive text search (perf/system-optimization): PostgreSQL `contains` maps
// to a case-sensitive LIKE, so the explicit `insensitive` mode is required there. The
// disposable SQLite test harness rejects the `mode` flag — its LIKE is already
// ASCII-case-insensitive, so the plain predicate gives the same user-visible behavior
// there. Detection uses the harness's own marker rather than env URLs: importing
// next/cache can leak .env values into process.env in test workers, so URL presence is
// not a reliable datasource signal.
const TEXT_SEARCH_MODE =
  process.env.KHAREEDO_DISPOSABLE_SQLITE_TEST === "1" ? undefined : ("insensitive" as const);
function containsQuery(value: string): Prisma.StringFilter {
  return TEXT_SEARCH_MODE
    ? { contains: value, mode: TEXT_SEARCH_MODE }
    : { contains: value };
}

export async function listProducts(filters: ProductFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(48, Math.max(1, filters.perPage ?? 12));

  const where: Prisma.ProductWhereInput = {
    status: "PUBLISHED", // FR-07, FR-13 — never offer drafts/archived
    deletedAt: null,
    category: { isActive: true },
  };

  if (filters.q) {
    const q = filters.q.trim();
    where.OR = [
      { name: containsQuery(q) },
      { description: containsQuery(q) },
      { brand: containsQuery(q) },
      { tags: containsQuery(q) },
    ];
  }
  if (filters.category) {
    // A parent category matches products in all of its descendants, at any
    // depth — not just direct children (Phase 3: 3-level+ trees).
    const subtreeSlugs = await getCategorySubtreeSlugs(filters.category);
    where.category = {
      isActive: true,
      slug: { in: subtreeSlugs },
    };
  }
  if (filters.brand) where.brand = filters.brand;
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    where.price = {};
    if (filters.minPrice !== undefined) where.price.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) where.price.lte = filters.maxPrice;
  }
  if (filters.featured) where.isFeatured = true;
  if (filters.inStockOnly) where.inventory = { some: { quantity: { gt: 0 } } };

  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    filters.sort === "price-asc"
      ? [{ price: "asc" }]
      : filters.sort === "price-desc"
        ? [{ price: "desc" }]
        : filters.sort === "rating"
          ? [{ rating: "desc" }]
          : filters.sort === "newest"
            ? [{ createdAt: "desc" }]
            : [{ isFeatured: "desc" }, { createdAt: "desc" }];

  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      select: listSelect,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.product.count({ where }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page,
    perPage,
    pages: Math.ceil(total / perPage),
  };
}

export async function getFeaturedProducts(limit = 8): Promise<ProductListItem[]> {
  const rows = await db.product.findMany({
     relationLoadStrategy: "join",
    where: { status: "PUBLISHED", deletedAt: null, isFeatured: true, category: { isActive: true } },
    select: listSelect,
    orderBy: [{ rating: "desc" }],
    take: limit,
  });
  return rows.map(toListItem);
}

export async function getNewArrivals(limit = 8): Promise<ProductListItem[]> {
  const rows = await db.product.findMany({
  relationLoadStrategy: "join",
  where: { status: "PUBLISHED", deletedAt: null, category: { isActive: true } },
  select: listSelect,
  orderBy: [{ createdAt: "desc" }],
  take: limit,
});
  return rows.map(toListItem);
}

/**
 * One parallel read for the homepage's two product lists and offers.
 * Separate limited/sorted lists preserve their existing rules and overlap.
 * Do not persistently cache prices, availability or time-bounded promotions.
 *
 * Implemented with standard typed queries instead of one raw round trip: the raw
 * version composed nested Prisma.sql fragments, which silently break under bundlers
 * that ship more than one Prisma runtime copy in the server bundle — a fragment built
 * by a different copy fails the client's instanceof check and is bound as a plain
 * parameter, producing `WITH featured AS ($1)` → PostgreSQL 42601 "syntax error at
 * or near $1". Each typed query here is indexed, bounded and uses the shared select,
 * so the parallel reads keep the same data shape with no fragile SQL composition.
 */
export async function getHomepageCatalog() {
  const now = new Date();
  const [featuredRows, newArrivalRows, promotionRows] = await Promise.all([
    db.product.findMany({
      relationLoadStrategy: "join",
      where: { status: "PUBLISHED", deletedAt: null, isFeatured: true, category: { isActive: true } },
      select: listSelect,
      orderBy: [{ rating: "desc" }],
      take: 8,
    }),
    db.product.findMany({
      relationLoadStrategy: "join",
      where: { status: "PUBLISHED", deletedAt: null, category: { isActive: true } },
      select: listSelect,
      orderBy: [{ createdAt: "desc" }],
      take: 4,
    }),
    db.promotion.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 2,
    }),
  ]);
  return {
    featured: featuredRows.map(toListItem),
    newArrivals: newArrivalRows.map(toListItem),
    promotions: promotionRows,
  };
}

export interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  description: string;
  brand: string | null;
  sku: string | null;
  price: number;
  comparePrice: number | null;
  status: string;
  rating: number;
  reviewCount: number;
  tags: string[];
  images: Array<{ url: string; alt: string | null }>;
  /** Total available stock across the product-level row and every variant
   *  row (Chunk 8 — D12). Per-variant stock is on `variants`. */
  stock: number;
  lowStockThreshold: number;
  /** Active variants with per-variant stock/pricing (empty = no variants).
   *  Inactive variants are never offered on the PDP. */
  variants: VariantDetail[];
  category: { id: string; name: string; slug: string; parentName: string | null };
}

const productDetailSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  brand: true,
  sku: true,
  price: true,
  comparePrice: true,
  status: true,
  rating: true,
  reviewCount: true,
  tags: true,
  images: {
    orderBy: { sortOrder: "asc" },
    select: { url: true, alt: true },
  },
  inventory: { select: { variantId: true, quantity: true, lowStockThreshold: true } },
  variants: {
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { inventory: true },
  },
  category: {
    select: {
      id: true,
      name: true,
      slug: true,
      parent: { select: { name: true } },
    },
  },
} satisfies Prisma.ProductSelect;

export async function getProductMetadataBySlug(slug: string) {
  return withPerformanceTiming("product.metadata", async () => {
    const product = await getProductBySlug(slug);
    if (!product) return null;
    return {
      name: product.name,
      description: product.description,
      images: product.images.slice(0, 1).map(({ url }) => ({ url })),
    };
  });
}

export const getProductBySlug = cache(async (slug: string): Promise<ProductDetail | null> =>
  withPerformanceTiming("product.details", async () => {
    const p = await db.product.findFirst({
      where: { slug, status: "PUBLISHED", deletedAt: null, category: { isActive: true } },
      select: productDetailSelect,
    });
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      brand: p.brand,
      sku: p.sku,
      price: p.price,
      comparePrice: p.comparePrice,
      status: p.status,
      rating: p.rating,
      reviewCount: p.reviewCount,
      tags: (p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      images: p.images.map((i) => ({ url: i.url, alt: i.alt ?? p.name })),
      stock: totalProductStock(p.inventory),
      lowStockThreshold: inventoryForVariant(p.inventory, null)?.lowStockThreshold ?? 5,
      variants: p.variants.map((v) => ({
        id: v.id,
        productId: v.productId,
        label: v.label,
        sku: v.sku,
        priceOverride: v.priceOverride,
        isActive: v.isActive,
        sortOrder: v.sortOrder,
        stock: v.inventory?.quantity ?? 0,
        lowStockThreshold: v.inventory?.lowStockThreshold ?? 5,
      })),
      category: {
        id: p.category.id,
        name: p.category.name,
        slug: p.category.slug,
        parentName: p.category.parent?.name ?? null,
      },
    };
  })
);

export async function getRelatedProducts(
  categoryId: string,
  excludeId: string,
  limit = 4
): Promise<ProductListItem[]> {
  return withPerformanceTiming("product.related", async () => {
    const rows = await db.product.findMany({
      where: { categoryId, status: "PUBLISHED", deletedAt: null, id: { not: excludeId } },
      select: listSelect,
      orderBy: [{ rating: "desc" }],
      take: limit,
    });
    return rows.map(toListItem);
  });
}

// ───────────────────────────── Storefront catalogue metadata ─────────────────────────────
//
// Cached 60s with unstable_cache, same shape as banners (S7). Brands and the
// price-slider cap feed the storefront filter sidebar only: display-only
// catalogue metadata, never prices charged, stock shown, or time-bounded
// promotions — so up-to-60s staleness after an admin product write is safe.
// No writer invalidates the tag yet (admin product writes also run in unit /
// integration tests, where revalidateTag throws outside a request scope);
// the 60s revalidate is the invalidation. The tag exists so a future writer
// can invalidate without changing the readers.
const CATALOGUE_META_CACHE_TAG = "storefront-catalogue-meta";

/** Run a cached catalogue-metadata read, falling back to a fresh read when
 *  the Next incremental cache is unavailable. In production (App Router)
 *  the cached path is used; outside a Next request scope — unit/integration
 *  tests, scripts — unstable_cache throws "Invariant: incrementalCache
 *  missing", and the fresh read keeps the function correct instead of
 *  failing. Both reads are pure, so the fallback cannot double-apply
 *  anything; a database failure still surfaces (the fresh read throws it
 *  too). Verified by probe: real unstable_cache throws that invariant in
 *  plain vitest, while module-scope wrapping itself is safe. */
async function withCatalogueMetaFallback<T>(
  cached: () => Promise<T>,
  fresh: () => Promise<T>,
): Promise<T> {
  try {
    return await cached();
  } catch {
    return await fresh();
  }
}

/** Distinct brands of live (published, non-deleted) products, for the
 *  storefront brand filter. Empty/whitespace-only brands are excluded. */
async function readCatalogueBrandsFresh(): Promise<string[]> {
  const rows = await db.product.findMany({
    where: { status: "PUBLISHED", deletedAt: null },
    select: { brand: true },
    distinct: ["brand"],
    orderBy: { brand: "asc" },
  });
  return rows
    .map((r) => r.brand)
    .filter((brand): brand is string => typeof brand === "string" && brand.trim().length > 0);
}

const readCatalogueBrandsCached = unstable_cache(readCatalogueBrandsFresh, ["catalogue-brands"], {
  revalidate: 60,
  tags: [CATALOGUE_META_CACHE_TAG],
});

export async function getCatalogueBrands(): Promise<string[]> {
  return withCatalogueMetaFallback(readCatalogueBrandsCached, readCatalogueBrandsFresh);
}

/** Data-driven price-slider cap (Phase 3): the highest live product price,
 *  rounded up to the next 500 so the slider always covers the catalogue.
 *  Defaults to 50000 when the catalogue is empty. */
async function readCatalogueMaxPriceFresh(): Promise<number> {
  const result = await db.product.aggregate({
    _max: { price: true },
    where: { status: "PUBLISHED", deletedAt: null },
  });
  const max = result._max.price ?? 0;
  if (max <= 0) return 50000;
  return Math.ceil(max / 500) * 500;
}

const readCatalogueMaxPriceCached = unstable_cache(
  readCatalogueMaxPriceFresh,
  ["catalogue-max-price"],
  { revalidate: 60, tags: [CATALOGUE_META_CACHE_TAG] },
);

export async function getCatalogueMaxPrice(): Promise<number> {
  return withCatalogueMetaFallback(readCatalogueMaxPriceCached, readCatalogueMaxPriceFresh);
}

// ───────────────────────────── Admin operations (FR-39/40, BR-14) ─────────────────────────────

export interface AdminProductFilters {
  q?: string;
  status?: string;
  categoryId?: string;
  page?: number;
}

export async function adminListProducts(filters: AdminProductFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = 15;
  // Archived products live in the deletedAt column (soft-delete); the
  // ARCHIVED status filter must query them, every other filter hides them.
  const where: Prisma.ProductWhereInput =
    filters.status === "ARCHIVED"
      ? { deletedAt: { not: null }, status: "ARCHIVED" }
      : { deletedAt: null };
  if (filters.q) where.name = containsQuery(filters.q.trim());
  if (filters.status && filters.status !== "ARCHIVED") where.status = filters.status;
  if (filters.categoryId) where.categoryId = filters.categoryId;

  const [rows, total, categories] = await Promise.all([
    db.product.findMany({
      where,
      select: listSelect,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.product.count({ where }),
    db.category.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true } }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page,
    perPage,
    pages: Math.ceil(total / perPage),
    categories,
  };
}

export async function adminGetProduct(id: string) {
  // No deletedAt filter: archived products must stay editable (and
  // restorable) — the detail is how the admin reaches them.
  const p = await db.product.findFirst({
    where: { id },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      inventory: true,
      variants: { include: { inventory: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      category: { select: { id: true } },
    },
  });
  if (!p) return null;
  const productLevel = inventoryForVariant(p.inventory, null);
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    brand: p.brand,
    sku: p.sku,
    categoryId: p.category.id,
    price: p.price,
    comparePrice: p.comparePrice,
    status: p.status,
    isFeatured: p.isFeatured,
    rating: p.rating,
    reviewCount: p.reviewCount,
    tags: p.tags ?? "",
    images: p.images.map((i) => i.url),
    stock: productLevel?.quantity ?? 0,
    lowStockThreshold: productLevel?.lowStockThreshold ?? 5,
    variants: p.variants.map((v) => ({
      id: v.id,
      productId: v.productId,
      label: v.label,
      sku: v.sku,
      priceOverride: v.priceOverride,
      isActive: v.isActive,
      sortOrder: v.sortOrder,
      stock: v.inventory?.quantity ?? 0,
      lowStockThreshold: v.inventory?.lowStockThreshold ?? 5,
    })),
    deletedAt: p.deletedAt,
  };
}

export interface ProductWriteInput {
  name: string;
  slug?: string;
  description?: string;
  brand?: string;
  sku?: string;
  categoryId: string;
  price: number;
  comparePrice?: number | null;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  isFeatured: boolean;
  // No rating / reviewCount: those are calculated from APPROVED reviews
  // only (src/services/reviews.service.ts) and must never be set through
  // a product write. Create starts at 0/0; update leaves the stored
  // calculated values untouched.
  tags?: string;
  images: string[];
  stock: number;
  lowStockThreshold?: number;
  /** Variants created with the product (Chunk 8 — D12). Each gets its own
   *  Inventory row; the product-level row above stays the no-variant stock.
   *  SKUs are checked against both variant and product SKUs. */
  variants?: Array<{
    label: string;
    sku: string;
    priceOverride?: number | null;
    stock: number;
    lowStockThreshold?: number;
    sortOrder?: number;
  }>;
}

async function ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = slugify(base) || `product-${Date.now()}`;
  let candidate = slug;
  let n = 1;
  // loop until free
  for (;;) {
    const clash = await db.product.findFirst({
      where: { slug: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (!clash) return candidate;
    candidate = `${slug}-${++n}`;
  }
}

/** Auto-generated SKU, e.g. "KH-20W-PD-FAS-37" (BR: stock keeping unit is system-assigned). */
async function ensureUniqueSku(name: string): Promise<string> {
  const base =
    slugify(name)
      .split("-")
      .filter(Boolean)
      .slice(0, 3)
      .map((w) => w.slice(0, 3).toUpperCase())
      .join("-") || "PRD";
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `KH-${base}-${Math.floor(10 + Math.random() * 90)}`;
    const clash = await db.product.findFirst({ where: { sku: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }
  return `KH-${base}-${Date.now().toString().slice(-6)}`;
}

export async function adminCreateProduct(input: ProductWriteInput) {
  const slug = await ensureUniqueSlug(input.slug || input.name);
  const sku = input.sku?.trim() || (await ensureUniqueSku(input.name));
  return db.$transaction(async (tx) => {
    await assertCategoryActive(tx, input.categoryId);
    const product = await tx.product.create({
      data: {
        name: input.name,
        slug,
        description: input.description ?? "",
        brand: input.brand || null,
        sku,
        categoryId: input.categoryId,
        price: input.price,
        comparePrice: input.comparePrice ?? null,
        status: input.status,
        isFeatured: input.isFeatured,
        // A new product has no approved reviews yet.
        rating: 0,
        reviewCount: 0,
        tags: input.tags ?? null,
        // ARCHIVED and deletedAt stay in sync: an archived product is a
        // soft-deleted one, so the admin list's ARCHIVED filter finds it.
        deletedAt: input.status === "ARCHIVED" ? new Date() : null,
        images: {
          create: input.images.map((url, i) => ({ url, sortOrder: i, alt: input.name })),
        },
      },
    });
    await tx.inventory.create({
      data: {
        productId: product.id,
        quantity: input.stock,
        lowStockThreshold: input.lowStockThreshold ?? 5,
      },
    });
    // Variants (Chunk 8 — D12): one variant row + one inventory row each,
    // in the same transaction as the product, so a duplicate SKU or a
    // failed variant rolls the whole product back instead of leaving a
    // variant-less product behind.
    if (input.variants && input.variants.length > 0) {
      const seenSkus = new Set<string>();
      for (const [i, v] of input.variants.entries()) {
        if (seenSkus.has(v.sku)) {
          throw new VariantSkuConflictError(`SKU "${v.sku}" is used twice in this product`, v.sku);
        }
        seenSkus.add(v.sku);
        await assertVariantSkuFree(tx, v.sku);
        const variant = await tx.productVariant.create({
          data: {
            productId: product.id,
            label: v.label,
            sku: v.sku,
            priceOverride: v.priceOverride ?? null,
            sortOrder: v.sortOrder ?? i,
          },
        });
        await tx.inventory.create({
          data: {
            productId: product.id,
            variantId: variant.id,
            quantity: v.stock,
            lowStockThreshold: v.lowStockThreshold ?? 5,
          },
        });
      }
    }
    return product;
  });
}

export async function adminUpdateProduct(id: string, input: ProductWriteInput) {
  const slug = await ensureUniqueSlug(input.slug || input.name, id);
  // Capture the current image URLs before the update replaces them, so
  // orphaned storage objects can be cleaned up after the write commits.
  const previous = await db.product.findUnique({
    where: { id },
    select: { images: { select: { url: true } } },
  });
  const product = await db.$transaction(async (tx) => {
    await assertCategoryActive(tx, input.categoryId);
    await writeAvailableStock(tx, { productId: id, quantity: input.stock, lowStockThreshold: input.lowStockThreshold ?? 5 });
    await tx.productImage.deleteMany({ where: { productId: id } });
    const updated = await tx.product.update({
      where: { id },
      data: {
        name: input.name,
        slug,
        description: input.description ?? "",
        brand: input.brand || null,
        // SKU is system-assigned; empty input keeps the existing code untouched
        ...(input.sku?.trim() ? { sku: input.sku.trim() } : {}),
        categoryId: input.categoryId,
        price: input.price,
        comparePrice: input.comparePrice ?? null,
        status: input.status,
        isFeatured: input.isFeatured,
        // rating / reviewCount are deliberately NOT written here: they
        // are calculated from APPROVED reviews only, and an edit must
        // never reset or overwrite them.
        tags: input.tags ?? null,
        // ARCHIVED and deletedAt stay in sync, so editing a product's
        // visibility back to DRAFT/PUBLISHED also restores it.
        deletedAt: input.status === "ARCHIVED" ? new Date() : null,
        images: {
          create: input.images.map((url, i) => ({ url, sortOrder: i, alt: input.name })),
        },
      },
    });
    return updated;
  });
  // Replaced/removed images: clean up the old storage objects if nothing
  // references them. Best-effort — a failure never breaks the update.
  const kept = new Set(input.images);
  for (const image of previous?.images ?? []) {
    if (!kept.has(image.url)) {
      await cleanupOrphanedMediaImage(image.url);
    }
  }
  return product;
}

/** Soft archive keeps historical order references intact (NFR-31). */
export async function adminArchiveProduct(id: string) {
  await db.product.update({
    where: { id },
    data: { status: "ARCHIVED", isFeatured: false, deletedAt: new Date() },
  });
}

/** Restore reverses exactly what archiving does: clears the soft-delete
 *  marker and returns the product to DRAFT — never auto-publish, so a
 *  restored product is visible to the admin but not sellable until it is
 *  deliberately published again. */
export async function adminRestoreProduct(id: string): Promise<{ ok: boolean; reason?: string }> {
  const existing = await db.product.findUnique({
    where: { id },
    select: { status: true, deletedAt: true },
  });
  if (!existing) return { ok: false, reason: "Product not found." };
  if (existing.status !== "ARCHIVED" || !existing.deletedAt) {
    return { ok: false, reason: "Only archived products can be restored." };
  }
  await db.product.update({
    where: { id },
    data: { status: "DRAFT", deletedAt: null },
  });
  return { ok: true };
}
