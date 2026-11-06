// Category service — navigation tree, listing, admin CRUD (FR-40, FR-51).
import { cache } from "react";
import { db } from "@/lib/db";
import { slugify } from "@/lib/utils";
import { Prisma } from "../../generated/postgres-client";

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  children: CategoryNode[];
}

const storefrontCategorySelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  imageUrl: true,
  parentId: true,
  sortOrder: true,
  _count: {
    select: {
      products: { where: { status: "PUBLISHED", deletedAt: null } },
    },
  },
} satisfies Prisma.CategorySelect;

const getActiveStorefrontCategories = cache(() =>
  db.category.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: storefrontCategorySelect,
  })
);

/** Parent/leaf tree for storefront navigation (only active categories, FR-07). */
export async function getCategoryTree(): Promise<CategoryNode[]> {
  const cats = await getActiveStorefrontCategories();
  const childrenByParent = new Map<string, CategoryNode[]>();
  // Every active child is already present in this sort-ordered flat result.
  for (const category of cats) {
    if (!category.parentId) continue;
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push({
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      imageUrl: category.imageUrl,
      children: [],
    });
    childrenByParent.set(category.parentId, children);
  }
  const roots = cats.filter((c) => !c.parentId);
  return roots.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    imageUrl: c.imageUrl,
    children: childrenByParent.get(c.id) ?? [],
  }));
}

/** Flat list with product counts for category circles / listing sidebar.
 *  Includes leaf categories AND parent categories that hold products directly. */
export async function getCategoriesWithCounts() {
  const cats = await getActiveStorefrontCategories();
  return cats
    .filter((c) => c._count.products > 0)
    .map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      imageUrl: c.imageUrl,
      productCount: c._count.products,
    }));
}

export const getCategoryBySlug = cache((slug: string) =>
  db.category.findUnique({ where: { slug }, include: { parent: true } })
);

export async function adminListCategories() {
  const cats = await db.category.findMany({
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }],
    include: {
      parent: { select: { name: true } },
      _count: { select: { products: true } },
    },
  });
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    imageUrl: c.imageUrl,
    parentId: c.parentId,
    parentName: c.parent?.name ?? null,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    productCount: c._count.products,
  }));
}

export interface CategoryWriteInput {
  name: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  parentId?: string | null;
  isActive: boolean;
  sortOrder: number;
}

async function ensureUniqueCatSlug(base: string, excludeId?: string): Promise<string> {
  let slug = slugify(base) || `category-${Date.now()}`;
  let candidate = slug;
  let n = 1;
  for (;;) {
    const clash = await db.category.findFirst({
      where: { slug: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (!clash) return candidate;
    candidate = `${slug}-${++n}`;
  }
}

export async function adminCreateCategory(input: CategoryWriteInput) {
  const slug = await ensureUniqueCatSlug(input.slug || input.name);
  return db.category.create({
    data: {
      name: input.name,
      slug,
      description: input.description || null,
      imageUrl: input.imageUrl || null,
      parentId: input.parentId || null,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    },
  });
}

export async function adminUpdateCategory(id: string, input: CategoryWriteInput) {
  const slug = await ensureUniqueCatSlug(input.slug || input.name, id);
  // Prevent self-parenting / cycles
  const parentId = input.parentId === id ? null : input.parentId || null;
  return db.category.update({
    where: { id },
    data: {
      name: input.name,
      slug,
      description: input.description || null,
      imageUrl: input.imageUrl || null,
      parentId,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    },
  });
}

/** Archive-safe delete: only allowed when category has no products/children. */
export async function adminDeleteCategory(id: string): Promise<{ ok: boolean; reason?: string }> {
  const [products, children] = await Promise.all([
    db.product.count({ where: { categoryId: id, deletedAt: null } }),
    db.category.count({ where: { parentId: id } }),
  ]);
  if (products > 0 || children > 0) {
    return { ok: false, reason: "Move or delete its products/subcategories first." };
  }
  await db.category.delete({ where: { id } });
  return { ok: true };
}
