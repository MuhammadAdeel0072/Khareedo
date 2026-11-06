// Product catalogue service — storefront reads (FR-07..13) + admin CRUD (FR-39/40).
import { cache } from "react";
import { Prisma, type Promotion } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import { writeAvailableStock } from "@/services/reservation-writes";
import { type ProductSort } from "@/lib/constants";
import { slugify } from "@/lib/utils";
import { withPerformanceTiming } from "@/lib/performance-timing";

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
  inventory: { select: { quantity: true } },
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
    stock: p.inventory?.quantity ?? 0,
    isFeatured: p.isFeatured,
    status: p.status,
    createdAt: p.createdAt,
    categoryName: p.category.name,
    categorySlug: p.category.slug,
  };
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
      { name: { contains: q } },
      { description: { contains: q } },
      { brand: { contains: q } },
      { tags: { contains: q } },
    ];
  }
  if (filters.category) {
    where.category = {
      isActive: true,
      OR: [
        { slug: filters.category },
        { parent: { slug: filters.category } },
      ],
    };
  }
  if (filters.brand) where.brand = filters.brand;
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    where.price = {};
    if (filters.minPrice !== undefined) where.price.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) where.price.lte = filters.maxPrice;
  }
  if (filters.featured) where.isFeatured = true;
  if (filters.inStockOnly) where.inventory = { quantity: { gt: 0 } };

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

type ProductJson = Omit<ProductListItem, "createdAt"> & { createdAt: string };
type PromotionJson = Omit<Promotion, "createdAt" | "updatedAt" | "startsAt" | "endsAt"> & {
  createdAt: string;
  updatedAt: string;
  startsAt: string | null;
  endsAt: string | null;
};

function productRows(featured: boolean, orderBy: Prisma.Sql, limit: number) {
  return Prisma.sql`
    SELECT p."id", p."name", p."slug", p."price", p."comparePrice", p."brand",
      p."rating", p."reviewCount", p."status", p."isFeatured",
      p."createdAt" AT TIME ZONE 'UTC' AS "createdAt",
      c."name" AS "categoryName", c."slug" AS "categorySlug",
      image."url" AS "image", COALESCE(i."quantity", 0) AS "stock"
    FROM "Product" p
    JOIN "Category" c ON c."id" = p."categoryId"
    LEFT JOIN "Inventory" i ON i."productId" = p."id"
    LEFT JOIN LATERAL (
      SELECT "url" FROM "ProductImage" WHERE "productId" = p."id"
      ORDER BY "sortOrder" ASC LIMIT 1
    ) image ON TRUE
    WHERE p."status" = 'PUBLISHED' AND p."deletedAt" IS NULL
      AND c."isActive" = TRUE ${featured ? Prisma.sql`AND p."isFeatured" = TRUE` : Prisma.empty}
    ORDER BY ${orderBy} LIMIT ${limit}
  `;
}

/**
 * One read-only round trip for the homepage's two product lists and offers.
 * Separate limited/sorted lists preserve their existing rules and overlap.
 * Do not persistently cache prices, availability or time-bounded promotions.
 */
export async function getHomepageCatalog() {
  const now = new Date();
  const [data] = await db.$queryRaw<Array<{
    featured: ProductJson[];
    newArrivals: ProductJson[];
    promotions: PromotionJson[];
  }>>(Prisma.sql`
    WITH featured AS (${productRows(true, Prisma.sql`p."rating" DESC`, 8)}),
      arrivals AS (${productRows(false, Prisma.sql`p."createdAt" DESC`, 4)})
    SELECT
      COALESCE((SELECT jsonb_agg(featured ORDER BY "rating" DESC) FROM featured), '[]'::jsonb) AS "featured",
      COALESCE((SELECT jsonb_agg(arrivals ORDER BY "createdAt" DESC) FROM arrivals), '[]'::jsonb) AS "newArrivals",
      COALESCE((SELECT jsonb_agg(offers ORDER BY "createdAt" DESC) FROM (
        SELECT "id", "title", "description", "type", "value", "minOrderAmount", "isActive",
          "startsAt" AT TIME ZONE 'UTC' AS "startsAt",
          "endsAt" AT TIME ZONE 'UTC' AS "endsAt",
          "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
          "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
        FROM "Promotion"
        WHERE "isActive" = TRUE
          AND ("startsAt" IS NULL OR "startsAt" <= ${now})
          AND ("endsAt" IS NULL OR "endsAt" >= ${now})
        ORDER BY "createdAt" DESC LIMIT ${2}
      ) offers), '[]'::jsonb) AS "promotions"
  `);

  const products = (rows: ProductJson[]): ProductListItem[] => rows.map(row => ({
    ...row, createdAt: new Date(row.createdAt),
  }));
  return {
    featured: products(data.featured),
    newArrivals: products(data.newArrivals),
    promotions: data.promotions.map((row): Promotion => ({
      ...row,
      startsAt: row.startsAt === null ? null : new Date(row.startsAt),
      endsAt: row.endsAt === null ? null : new Date(row.endsAt),
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    })),
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
  stock: number;
  lowStockThreshold: number;
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
  inventory: { select: { quantity: true, lowStockThreshold: true } },
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
      stock: p.inventory?.quantity ?? 0,
      lowStockThreshold: p.inventory?.lowStockThreshold ?? 5,
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
  const where: Prisma.ProductWhereInput = { deletedAt: null };
  if (filters.q) where.name = { contains: filters.q.trim() };
  if (filters.status) where.status = filters.status;
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
  const p = await db.product.findFirst({
    where: { id, deletedAt: null },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      inventory: true,
      category: { select: { id: true } },
    },
  });
  if (!p) return null;
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
    stock: p.inventory?.quantity ?? 0,
    lowStockThreshold: p.inventory?.lowStockThreshold ?? 5,
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
  rating?: number;
  reviewCount?: number;
  tags?: string;
  images: string[];
  stock: number;
  lowStockThreshold?: number;
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
        rating: input.rating ?? 0,
        reviewCount: input.reviewCount ?? 0,
        tags: input.tags ?? null,
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
    return product;
  });
}

export async function adminUpdateProduct(id: string, input: ProductWriteInput) {
  const slug = await ensureUniqueSlug(input.slug || input.name, id);
  return db.$transaction(async (tx) => {
    await writeAvailableStock(tx, { productId: id, quantity: input.stock, lowStockThreshold: input.lowStockThreshold ?? 5 });
    await tx.productImage.deleteMany({ where: { productId: id } });
    const product = await tx.product.update({
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
        rating: input.rating ?? 0,
        reviewCount: input.reviewCount ?? 0,
        tags: input.tags ?? null,
        images: {
          create: input.images.map((url, i) => ({ url, sortOrder: i, alt: input.name })),
        },
      },
    });
    return product;
  });
}

/** Soft archive keeps historical order references intact (NFR-31). */
export async function adminArchiveProduct(id: string) {
  await db.product.update({
    where: { id },
    data: { status: "ARCHIVED", isFeatured: false, deletedAt: new Date() },
  });
}
