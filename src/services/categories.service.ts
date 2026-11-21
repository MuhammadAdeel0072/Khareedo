// Category service — navigation tree, listing, admin CRUD (FR-40, FR-51).
import { cache } from "react";
import { db } from "@/lib/db";
import { slugify } from "@/lib/utils";
import { cleanupOrphanedMediaImage } from "@/services/media-cleanup.service";
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

/** Parent/leaf tree for storefront navigation (only active categories, FR-07).
 *  Built recursively, so the tree supports any depth (Phase 3: grandchildren
 *  and deeper levels are no longer dropped). A depth cap + visited set guard
 *  against pathological or legacy-cyclic data — a cycle can never hang the
 *  navigation render. */
const CATEGORY_TREE_MAX_DEPTH = 10;

export async function getCategoryTree(): Promise<CategoryNode[]> {
  const cats = await getActiveStorefrontCategories();
  const nodeById = new Map<string, CategoryNode>();
  for (const category of cats) {
    nodeById.set(category.id, {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      imageUrl: category.imageUrl,
      children: [],
    });
  }
  const childrenByParent = new Map<string, CategoryNode[]>();
  for (const category of cats) {
    if (!category.parentId) continue;
    const node = nodeById.get(category.id);
    if (!node) continue;
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push(node);
    childrenByParent.set(category.parentId, children);
  }
  const build = (id: string, depth: number, seen: Set<string>): CategoryNode | null => {
    const node = nodeById.get(id);
    if (!node || seen.has(id) || depth > CATEGORY_TREE_MAX_DEPTH) return null;
    const branchSeen = new Set(seen);
    branchSeen.add(id);
    node.children = (childrenByParent.get(id) ?? [])
      .map((child) => build(child.id, depth + 1, branchSeen))
      .filter((child): child is CategoryNode => child !== null);
    return node;
  };
  return cats
    .filter((c) => !c.parentId)
    .map((c) => build(c.id, 0, new Set()))
    .filter((node): node is CategoryNode => node !== null);
}

/** Slugs of a category and all of its active descendants (itself first).
 *  Used for product filtering by a parent category (FR-10): a product in a
 *  grandchild category must appear when filtering by the grandparent.
 *  Unknown slugs resolve to just themselves, so filtering by a missing
 *  category still matches nothing. */
export async function getCategorySubtreeSlugs(slug: string): Promise<string[]> {
  const cats = await getActiveStorefrontCategories();
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  const root = bySlug.get(slug);
  if (!root) return [slug];
  const childrenByParent = new Map<string, typeof cats>();
  for (const category of cats) {
    if (!category.parentId) continue;
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push(category);
    childrenByParent.set(category.parentId, children);
  }
  const slugs = [root.slug];
  const queue = [root.id];
  const seen = new Set([root.id]);
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      slugs.push(child.slug);
      queue.push(child.id);
    }
  }
  return slugs;
}

/** Flat list with product counts for category circles / listing sidebar.
 *  Includes empty categories (productCount 0): the navigation shows them,
 *  so the sidebar filter must too — selecting one shows the storefront
 *  empty state instead of pretending the category does not exist. */
export async function getCategoriesWithCounts() {
  const cats = await getActiveStorefrontCategories();
  return cats.map((c) => ({
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

/** A category write that fails a business rule (cycle, deactivation with
 *  live products). The API routes map this to a 422 with a clear message;
 *  it is not a server error. */
export class CategoryValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "CategoryValidationError";
  }
}

/** Ids of a category and all of its descendants (itself first), from a flat
 *  id/parentId list. Used for the deactivation block, where products in a
 *  subcategory are hidden along with the parent. */
function collectDescendantIds(
  all: Array<{ id: string; parentId: string | null }>,
  rootId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const category of all) {
    if (!category.parentId) continue;
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push(category.id);
    childrenByParent.set(category.parentId, children);
  }
  const ids = [rootId];
  const queue = [rootId];
  const seen = new Set([rootId]);
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      ids.push(childId);
      queue.push(childId);
    }
  }
  return ids;
}

/** Reject a parent that would create a cycle: the category itself, or any
 *  of its descendants (walk the proposed parent's ancestors; meeting the
 *  category's own id proves the cycle). A bounded walk + visited set also
 *  protect against pre-existing cyclic data. Creation needs no check — a
 *  brand-new category has no descendants yet. */
async function assertNoParentCycle(id: string, parentId: string | null): Promise<void> {
  if (!parentId) return;
  let current: string | null = parentId;
  const seen = new Set<string>();
  for (let steps = 0; steps < 100 && current; steps++) {
    if (current === id) {
      throw new CategoryValidationError(
        "A category cannot be moved under itself or one of its subcategories.",
        "parentId",
      );
    }
    if (seen.has(current)) break; // pre-existing cycle in data — stop, don't loop forever
    seen.add(current);
    const row = await db.category.findUnique({ where: { id: current }, select: { parentId: true } });
    current = row?.parentId ?? null;
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
  const parentId = input.parentId || null;
  // Self-parenting is a cycle of one — reject it with a clear error instead
  // of silently coercing it to a root (the old behaviour hid the mistake).
  if (parentId === id) {
    throw new CategoryValidationError("A category cannot be its own parent.", "parentId");
  }
  await assertNoParentCycle(id, parentId);

  const existing = await db.category.findUnique({
    where: { id },
    select: { isActive: true, imageUrl: true },
  });

  // Deactivating hides the category from navigation and filtering, which
  // also hides every live product in it and its subcategories. Block the
  // deactivation instead of silently hiding sellable stock: the admin must
  // move or delete those products first. (Re-activating is always allowed.)
  if (existing?.isActive && input.isActive === false) {
    const links = await db.category.findMany({ select: { id: true, parentId: true } });
    const subtreeIds = collectDescendantIds(links, id);
    const productCount = await db.product.count({
      where: { categoryId: { in: subtreeIds }, deletedAt: null },
    });
    if (productCount > 0) {
      throw new CategoryValidationError(
        `Cannot hide this category: ${productCount} product${productCount === 1 ? "" : "s"} in this category or its subcategories would disappear from the store. Move or delete them first.`,
        "isActive",
      );
    }
  }

  const category = await db.category.update({
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

  // Replaced image: clean up the old storage object if nothing references it.
  if (existing?.imageUrl && existing.imageUrl !== input.imageUrl) {
    await cleanupOrphanedMediaImage(existing.imageUrl);
  }
  return category;
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
  const category = await db.category.findUnique({ where: { id }, select: { imageUrl: true } });
  await db.category.delete({ where: { id } });
  // The deleted category's image is unreferenced now — clean it up if
  // nothing else (a product image, another category) shares the URL.
  if (category?.imageUrl) {
    await cleanupOrphanedMediaImage(category.imageUrl);
  }
  return { ok: true };
}
