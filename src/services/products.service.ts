// Product catalogue service — storefront reads (FR-07..13) + admin CRUD (FR-39/40).
import { cache } from "react";
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import { type ProductSort } from "@/lib/constants";
import { slugify } from "@/lib/utils";

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

/** Resolve a category slug to the category + its children ids (for nav filtering). */
async function categoryScope(slug: string): Promise<string[] | null> {
  const cat = await db.category.findUnique({
    where: { slug },
    include: { children: { select: { id: true } } },
  });
  if (!cat) return null;
  return [cat.id, ...cat.children.map((c) => c.id)];
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
    const ids = await categoryScope(filters.category);
    if (!ids) return { items: [], total: 0, page, perPage, pages: 0 };
    where.categoryId = { in: ids };
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
    where: { status: "PUBLISHED", deletedAt: null, isFeatured: true, category: { isActive: true } },
    select: listSelect,
    orderBy: [{ rating: "desc" }],
    take: limit,
  });
  return rows.map(toListItem);
}

export async function getNewArrivals(limit = 8): Promise<ProductListItem[]> {
  const rows = await db.product.findMany({
    where: { status: "PUBLISHED", deletedAt: null, category: { isActive: true } },
    select: listSelect,
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });
  return rows.map(toListItem);
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

export async function getProductMetadataBySlug(slug: string) {
  return db.product.findFirst({
    where: { slug, status: "PUBLISHED", deletedAt: null, category: { isActive: true } },
    select: {
      name: true,
      description: true,
      images: {
        take: 1,
        orderBy: { sortOrder: "asc" },
        select: { url: true },
      },
    },
  });
}

export const getProductBySlug = cache(async (slug: string): Promise<ProductDetail | null> => {
  const p = await db.product.findFirst({
    where: { slug, status: "PUBLISHED", deletedAt: null, category: { isActive: true } },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      inventory: true,
      category: { include: { parent: { select: { name: true } } } },
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
});

export async function getRelatedProducts(
  categoryId: string,
  excludeId: string,
  limit = 4
): Promise<ProductListItem[]> {
  const rows = await db.product.findMany({
    where: { categoryId, status: "PUBLISHED", deletedAt: null, id: { not: excludeId } },
    select: listSelect,
    orderBy: [{ rating: "desc" }],
    take: limit,
  });
  return rows.map(toListItem);
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
    const inv = await tx.inventory.findUnique({ where: { productId: id } });
    if (inv) {
      await tx.inventory.update({
        where: { productId: id },
        data: { quantity: input.stock, lowStockThreshold: input.lowStockThreshold ?? 5 },
      });
    } else {
      await tx.inventory.create({
        data: { productId: id, quantity: input.stock, lowStockThreshold: input.lowStockThreshold ?? 5 },
      });
    }
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

export async function adminDeleteProductImage(imageId: string) {
  await db.productImage.delete({ where: { id: imageId } });
}
