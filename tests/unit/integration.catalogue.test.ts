// Integration test — catalogue correctness (Phase 3, Chunk 5). Run with:
// npm run test:db
//
// Covers category admin CRUD (previously ZERO coverage) and the product
// catalogue fixes against the real Prisma layer on a disposable SQLite
// database: slug dedup + non-Latin fallback, invalid parent (422), cycle
// rejection, 409 on delete-with-products, inactive-category rejection,
// archive/restore round-trip, 3-level descendant filtering, root image,
// empty categories, brand + data-driven max price, and orphaned-image
// cleanup (storage client mocked at the Supabase boundary only — the
// business logic, reference checks and URL parsing are all real).
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const mocks = vi.hoisted(() => ({
  adminUser: {
    id: "admin-1",
    email: "admin@example.invalid",
    name: "Test Admin",
    role: "ADMIN",
    mfaEnabledAt: new Date("2026-11-19T00:00:00.000Z"),
    mfaLastVerifiedAt: new Date("2026-11-19T00:00:00.000Z"),
    mfaLastVerifiedSessionId: "session-aaa",
    sessionSid: "session-aaa",
  },
  requireAdmin: vi.fn(),
  storageRemove: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});
vi.mock("@/lib/auth-guard", () => ({
  AuthError: class AuthError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  MfaRequiredError: class MfaRequiredError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  requireAdmin: mocks.requireAdmin,
  requireAdminMfaVerified: mocks.requireAdmin,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    storage: { from: () => ({ remove: mocks.storageRemove }) },
  })),
}));

import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import {
  adminCreateCategory,
  adminDeleteCategory,
  adminUpdateCategory,
  CategoryValidationError,
  getCategoriesWithCounts,
  getCategorySubtreeSlugs,
  getCategoryTree,
} from "@/services/categories.service";
import {
  adminArchiveProduct,
  adminCreateProduct,
  adminGetProduct,
  adminListProducts,
  adminRestoreProduct,
  adminUpdateProduct,
  getCatalogueBrands,
  getCatalogueMaxPrice,
  InactiveCategoryError,
  listProducts,
} from "@/services/products.service";
import { categoryWriteErrorResponse } from "@/lib/category-api-errors";
import {
  productWriteErrorResponse,
  validateProductCategory,
} from "@/lib/product-api-errors";
import { POST as createCategory } from "@/app/api/admin/categories/route";
import { PUT as updateCategory, DELETE as deleteCategory } from "@/app/api/admin/categories/[id]/route";
import { POST as createProduct } from "@/app/api/admin/products/route";
import { PUT as updateProduct } from "@/app/api/admin/products/[id]/route";
import { POST as restoreProduct } from "@/app/api/admin/products/[id]/restore/route";

// These tests run only through the disposable SQLite test harness. They
// exercise the real Prisma layer and never use the application's configured
// database.
assertDisposableTestDatabase();

const TEST_STORAGE_URL = "https://test.supabase.co";

function storageUrl(key: string) {
  return `${TEST_STORAGE_URL}/storage/v1/object/public/product-images/${key}`;
}

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function category(overrides: Record<string, unknown> = {}) {
  const suffix = randomUUID();
  return db.category.create({
    data: {
      name: `Category ${suffix}`,
      slug: suffix,
      isActive: true,
      ...overrides,
    },
  });
}

async function product(overrides: Record<string, unknown> = {}) {
  const suffix = randomUUID();
  const categoryId =
    (overrides.categoryId as string | undefined) ??
    (await category()).id;
  const { categoryId: _ignored, images, ...rest } = overrides as {
    categoryId?: string;
    images?: string[];
    [key: string]: unknown;
  };
  return db.product.create({
    data: {
      name: `Product ${suffix}`,
      slug: suffix,
      categoryId,
      price: 1200,
      status: "PUBLISHED",
      images: { create: (images ?? ["/product.png"]).map((url, i) => ({ url, sortOrder: i })) },
      inventory: { create: { quantity: 5, lowStockThreshold: 1 } },
      ...rest,
    },
  });
}

function productBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Product",
    categoryId: "",
    price: 100,
    status: "PUBLISHED",
    isFeatured: false,
    images: ["https://example.com/one.jpg"],
    stock: 3,
    ...overrides,
  };
}

describe.skipIf(process.env.KHAREEDO_DISPOSABLE_SQLITE_TEST !== "1")("catalogue correctness", () => {
  beforeAll(async () => {
    assertDisposableTestDatabase();
    process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_STORAGE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    // The audit log FK-references the admin user, so the mocked admin must
    // be a real row — a fabricated id makes every audit write fail.
    const admin = await db.user.create({
      data: {
        email: `catalogue-admin-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`,
        name: "Catalogue Admin",
        passwordHash: await bcrypt.hash("test-password", 12),
        emailVerified: new Date(),
        role: "ADMIN",
      },
    });
    mocks.adminUser.id = admin.id;
    mocks.requireAdmin.mockResolvedValue(mocks.adminUser);
  });

  beforeEach(() => {
    mocks.storageRemove.mockReset();
    mocks.storageRemove.mockResolvedValue({ data: null, error: null });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("dedups category slugs and never produces an empty slug for non-Latin names", async () => {
    const first = await adminCreateCategory({ name: "Shoes", isActive: true, sortOrder: 0 });
    const second = await adminCreateCategory({ name: "Shoes", isActive: true, sortOrder: 0 });
    expect(first.slug).toBe("shoes");
    expect(second.slug).toBe("shoes-2");

    const nonLatin = await adminCreateCategory({ name: "محصولات", isActive: true, sortOrder: 0 });
    expect(nonLatin.slug).toMatch(/^category-\d+$/);

    const nonLatinProduct = await adminCreateProduct({
      name: "محصول",
      categoryId: first.id,
      price: 100,
      status: "DRAFT",
      isFeatured: false,
      images: ["/x.png"],
      stock: 1,
    });
    expect(nonLatinProduct.slug).toMatch(/^product-\d+$/);
  });

  it("maps an invalid parentId to a 422 parent-not-found error (not a 500)", async () => {
    const res = await createCategory(
      jsonRequest("http://localhost/api/admin/categories", {
        name: "Orphan",
        parentId: randomUUID(),
        isActive: true,
        sortOrder: 0,
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/parent category/i);
    expect(body.errors?.parentId).toBeTruthy();

    // The mapper itself: P2003 -> 422, P2002 (slug) -> 409.
    const p2003 = categoryWriteErrorResponse(
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test" }),
    );
    expect(p2003?.status).toBe(422);
    const p2002 = categoryWriteErrorResponse(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["slug"] },
      }),
    );
    expect(p2002?.status).toBe(409);
    const p2002Product = productWriteErrorResponse(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["slug"] },
      }),
    );
    expect(p2002Product?.status).toBe(409);
    expect((await p2002Product?.json())?.error).toMatch(/slug/i);

    // The product mapper must duck-type Prisma errors by name + code, like
    // the category mapper: the disposable SQLite harness throws the
    // sqlite-generated client's error class, so a bare instanceof silently
    // misses it and the route would 500 (Phase 3, chunk 12). A plain object
    // with the right name + code must still map.
    const foreignP2003 = productWriteErrorResponse({
      name: "PrismaClientKnownRequestError",
      code: "P2003",
    } as unknown as Error);
    expect(foreignP2003?.status).toBe(422);
    expect((await foreignP2003?.json())?.error).toMatch(/category/i);
    const foreignP2002 = productWriteErrorResponse({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      meta: { target: ["slug"] },
    } as unknown as Error);
    expect(foreignP2002?.status).toBe(409);
  });

  it("rejects parent cycles: self-parenting and moving under a descendant", async () => {
    const root = await category();
    const child = await category({ parentId: root.id });
    const grandchild = await category({ parentId: child.id });

    // Self-parenting.
    const selfRes = await updateCategory(
      jsonRequest(`http://localhost/api/admin/categories/${root.id}`, {
        name: root.name,
        parentId: root.id,
        isActive: true,
        sortOrder: 0,
      }, "PUT"),
      { params: Promise.resolve({ id: root.id }) },
    );
    expect(selfRes.status).toBe(422);
    expect((await selfRes.json()).error).toMatch(/own parent/i);

    // Moving the root under its grandchild.
    await expect(
      adminUpdateCategory(root.id, {
        name: root.name,
        parentId: grandchild.id,
        isActive: true,
        sortOrder: 0,
      }),
    ).rejects.toThrow(CategoryValidationError);

    // Moving the child under its own grandchild.
    const cycleRes = await updateCategory(
      jsonRequest(`http://localhost/api/admin/categories/${child.id}`, {
        name: child.name,
        parentId: grandchild.id,
        isActive: true,
        sortOrder: 0,
      }, "PUT"),
      { params: Promise.resolve({ id: child.id }) },
    );
    expect(cycleRes.status).toBe(422);
    expect((await cycleRes.json()).error).toMatch(/subcategor/i);

    // The tree is unchanged after the rejected moves.
    const after = await db.category.findUnique({ where: { id: root.id }, select: { parentId: true } });
    expect(after?.parentId).toBeNull();
  });

  it("returns 409 when deleting a category with products or subcategories", async () => {
    const withProducts = await category();
    await product({ categoryId: withProducts.id });
    expect(await adminDeleteCategory(withProducts.id)).toEqual({
      ok: false,
      reason: expect.stringContaining("products"),
    });

    const withChildren = await category();
    await category({ parentId: withChildren.id });
    const res = await deleteCategory(new Request(`http://localhost/api/admin/categories/${withChildren.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: withChildren.id }),
    });
    expect(res.status).toBe(409);

    const empty = await category();
    expect(await adminDeleteCategory(empty.id)).toEqual({ ok: true });
    expect(await db.category.findUnique({ where: { id: empty.id } })).toBeNull();
  });

  it("rejects assigning a product to an inactive category and leaves it unchanged", async () => {
    const inactive = await category({ isActive: false });
    const active = await category();

    const validation = await validateProductCategory(inactive.id);
    expect(validation?.status).toBe(422);
    expect((await validation?.json())?.errors?.categoryId).toMatch(/inactive/i);
    expect(await validateProductCategory(active.id)).toBeNull();

    // Service-level guard (covers the import flow, which bypasses the route).
    const before = await db.product.count();
    await expect(
      adminCreateProduct({
        name: "Hidden Product",
        categoryId: inactive.id,
        price: 100,
        status: "PUBLISHED",
        isFeatured: false,
        images: ["/x.png"],
        stock: 1,
      }),
    ).rejects.toThrow(InactiveCategoryError);
    expect(await db.product.count()).toBe(before);

    // Route-level guard.
    const res = await createProduct(
      jsonRequest(
        "http://localhost/api/admin/products",
        productBody({ categoryId: inactive.id }),
      ),
    );
    expect(res.status).toBe(422);
    expect(await db.product.count()).toBe(before);

    // Updating an existing product into the inactive category is blocked too.
    const existing = await product({ categoryId: active.id });
    await expect(
      adminUpdateProduct(existing.id, {
        name: existing.name,
        categoryId: inactive.id,
        price: existing.price,
        status: "PUBLISHED",
        isFeatured: false,
        images: ["/x.png"],
        stock: 1,
      }),
    ).rejects.toThrow(InactiveCategoryError);
    const unchanged = await db.product.findUnique({ where: { id: existing.id }, select: { categoryId: true } });
    expect(unchanged?.categoryId).toBe(active.id);
  });

  it("creates products at zero rating/reviewCount and rejects rating payloads at the route", async () => {
    const cat = await category();
    const before = await db.product.count();

    // A create carrying rating/reviewCount is rejected (422) — ratings are
    // calculated from APPROVED reviews only and are never admin-settable.
    const rejected = await createProduct(
      jsonRequest(
        "http://localhost/api/admin/products",
        productBody({ categoryId: cat.id, rating: 5, reviewCount: 99 }),
      ),
    );
    expect(rejected.status).toBe(422);
    expect(await db.product.count()).toBe(before);

    // A valid create starts at 0/0 — a new product has no approved reviews.
    const created = await adminCreateProduct({
      name: "Rated Later",
      categoryId: cat.id,
      price: 500,
      status: "PUBLISHED",
      isFeatured: false,
      images: ["/x.png"],
      stock: 2,
    });
    const aggregate = await db.product.findUnique({
      where: { id: created.id },
      select: { rating: true, reviewCount: true },
    });
    expect(aggregate).toEqual({ rating: 0, reviewCount: 0 });
  });

  it("product updates never overwrite calculated rating/reviewCount", async () => {
    const cat = await category();
    const seeded = await product({ categoryId: cat.id });
    // Simulate the moderation recompute (Chunk 9) having set these values.
    await db.product.update({
      where: { id: seeded.id },
      data: { rating: 4.5, reviewCount: 12 },
    });

    // A direct API call carrying rating/reviewCount is rejected and the
    // stored calculated values are untouched.
    const rejected = await updateProduct(
      jsonRequest(
        `http://localhost/api/admin/products/${seeded.id}`,
        productBody({ categoryId: cat.id, name: "Hacked Rating", rating: 1, reviewCount: 1 }),
        "PUT",
      ),
      { params: Promise.resolve({ id: seeded.id }) },
    );
    expect(rejected.status).toBe(422);
    const afterReject = await db.product.findUnique({
      where: { id: seeded.id },
      select: { name: true, rating: true, reviewCount: true },
    });
    expect(afterReject).toEqual({ name: seeded.name, rating: 4.5, reviewCount: 12 });

    // A legitimate edit changes the editable fields only; the calculated
    // aggregates survive it.
    await adminUpdateProduct(seeded.id, {
      name: "Renamed Product",
      categoryId: cat.id,
      price: 1500,
      status: "PUBLISHED",
      isFeatured: false,
      images: ["/x.png"],
      stock: 1,
    });
    const afterEdit = await db.product.findUnique({
      where: { id: seeded.id },
      select: { name: true, price: true, rating: true, reviewCount: true },
    });
    expect(afterEdit).toEqual({ name: "Renamed Product", price: 1500, rating: 4.5, reviewCount: 12 });
  });

  it("blocks deactivating a category with live products and reports the count", async () => {
    const root = await category();
    const child = await category({ parentId: root.id });
    await product({ categoryId: root.id });
    await product({ categoryId: root.id });
    await product({ categoryId: child.id });

    await expect(
      adminUpdateCategory(root.id, { name: root.name, isActive: false, sortOrder: 0 }),
    ).rejects.toThrow(/3 products/);
    const stillActive = await db.category.findUnique({ where: { id: root.id }, select: { isActive: true } });
    expect(stillActive?.isActive).toBe(true);

    // Deactivating an empty category succeeds, and re-activating is allowed.
    const empty = await category();
    const deactivated = await adminUpdateCategory(empty.id, {
      name: empty.name,
      isActive: false,
      sortOrder: 0,
    });
    expect(deactivated.isActive).toBe(false);
    const reactivated = await adminUpdateCategory(empty.id, {
      name: empty.name,
      isActive: true,
      sortOrder: 0,
    });
    expect(reactivated.isActive).toBe(true);
  });

  it("round-trips archive then restore, and restores to DRAFT (never auto-publish)", async () => {
    const item = await product();
    expect((await listProducts({})).items.some((p) => p.id === item.id)).toBe(true);

    await adminArchiveProduct(item.id);
    const archived = await db.product.findUnique({ where: { id: item.id } });
    expect(archived?.status).toBe("ARCHIVED");
    expect(archived?.deletedAt).not.toBeNull();
    expect((await listProducts({})).items.some((p) => p.id === item.id)).toBe(false);
    // The archived row shows up under the ARCHIVED admin filter, and the
    // admin detail still loads it (so it can be edited/restored).
    expect((await adminListProducts({ status: "ARCHIVED" })).items.some((p) => p.id === item.id)).toBe(true);
    expect(await adminGetProduct(item.id)).not.toBeNull();

    // Restoring a product that is not archived is a 409.
    const other = await product();
    const notArchived = await restoreProduct(new Request(`http://localhost/api/admin/products/${other.id}/restore`, { method: "POST" }), {
      params: Promise.resolve({ id: other.id }),
    });
    expect(notArchived.status).toBe(409);

    // Restore through the route: DRAFT + deletedAt cleared, audit recorded.
    const res = await restoreProduct(new Request(`http://localhost/api/admin/products/${item.id}/restore`, { method: "POST" }), {
      params: Promise.resolve({ id: item.id }),
    });
    expect(res.status).toBe(200);
    const restored = await db.product.findUnique({ where: { id: item.id } });
    expect(restored?.status).toBe("DRAFT");
    expect(restored?.deletedAt).toBeNull();
    expect((await listProducts({})).items.some((p) => p.id === item.id)).toBe(false); // still not sellable
    const audit = await db.adminAuditLog.findFirst({
      where: { action: "admin.product.restored", targetId: item.id },
    });
    expect(audit).not.toBeNull();

    // Publishing it again makes it visible and purchasable.
    await adminUpdateProduct(item.id, {
      name: item.name,
      categoryId: item.categoryId,
      price: item.price,
      status: "PUBLISHED",
      isFeatured: false,
      images: ["/product.png"],
      stock: 5,
    });
    expect((await listProducts({})).items.some((p) => p.id === item.id)).toBe(true);

    // Restoring an unknown product is a 404.
    const missingId = randomUUID();
    const missing = await restoreProduct(new Request(`http://localhost/api/admin/products/${missingId}/restore`, { method: "POST" }), {
      params: Promise.resolve({ id: missingId }),
    });
    expect(missing.status).toBe(404);
  });

  it("includes grandchildren in the tree and in parent-category filtering", async () => {
    const root = await category();
    const child = await category({ parentId: root.id });
    const grandchild = await category({ parentId: child.id });
    const item = await product({ categoryId: grandchild.id });

    const tree = await getCategoryTree();
    const rootNode = tree.find((c) => c.id === root.id)!;
    expect(rootNode.children[0].id).toBe(child.id);
    expect(rootNode.children[0].children[0].id).toBe(grandchild.id);

    const slugs = await getCategorySubtreeSlugs(root.slug);
    expect(slugs).toEqual(expect.arrayContaining([root.slug, child.slug, grandchild.slug]));

    const byRoot = await listProducts({ category: root.slug });
    expect(byRoot.items.some((p) => p.id === item.id)).toBe(true);
    const byChild = await listProducts({ category: child.slug });
    expect(byChild.items.some((p) => p.id === item.id)).toBe(true);
    const byGrandchild = await listProducts({ category: grandchild.slug });
    expect(byGrandchild.items.some((p) => p.id === item.id)).toBe(true);
  });

  it("carries root images and lists empty categories in the sidebar counts", async () => {
    const root = await category({ imageUrl: "/root.png" });
    const empty = await category();
    await category({ isActive: false });

    const tree = await getCategoryTree();
    expect(tree.find((c) => c.id === root.id)?.imageUrl).toBe("/root.png");

    const counts = await getCategoriesWithCounts();
    expect(counts.find((c) => c.id === root.id)?.imageUrl).toBe("/root.png");
    expect(counts.find((c) => c.id === empty.id)?.productCount).toBe(0);
    expect(counts.some((c) => c.id === empty.id)).toBe(true);
  });

  it("lists brands and computes a data-driven price cap from live products", async () => {
    const active = await category();
    await product({ categoryId: active.id, brand: "Acme", price: 44999 });
    await product({ categoryId: active.id, brand: "Zeta", price: 1200 });
    await product({ categoryId: active.id, brand: "DraftOnly", price: 90000, status: "DRAFT" });
    await product({ categoryId: active.id, brand: "Deleted", price: 80000, status: "PUBLISHED", deletedAt: new Date() });

    const brands = await getCatalogueBrands();
    expect(brands).toContain("Acme");
    expect(brands).toContain("Zeta");
    expect(brands).not.toContain("DraftOnly");
    expect(brands).not.toContain("Deleted");

    // Rounding rule, checked against a price above anything the seed or
    // other suites create (999999 -> next 500 is 1000000). The product is
    // deleted again so the shared disposable database is left clean.
    const expensive = await product({ categoryId: active.id, brand: "Acme", price: 999999 });
    expect(await getCatalogueMaxPrice()).toBe(1000000);
    await db.product.delete({ where: { id: expensive.id } });
  });

  it("filters the admin list by status and category", async () => {
    const catA = await category();
    const catB = await category();
    const archived = await product({ categoryId: catA.id });
    await adminArchiveProduct(archived.id);
    const published = await product({ categoryId: catB.id });

    const byStatus = await adminListProducts({ status: "ARCHIVED" });
    expect(byStatus.items.some((p) => p.id === archived.id)).toBe(true);
    expect(byStatus.items.some((p) => p.id === published.id)).toBe(false);

    const byCategory = await adminListProducts({ categoryId: catB.id });
    expect(byCategory.items.some((p) => p.id === published.id)).toBe(true);
    expect(byCategory.items.some((p) => p.id === archived.id)).toBe(false);

    const combined = await adminListProducts({ status: "PUBLISHED", categoryId: catB.id });
    expect(combined.items.some((p) => p.id === published.id)).toBe(true);
  });

  it("cleans up replaced product images and protects still-referenced ones", async () => {
    const oldKey = `${randomUUID()}.png`;
    const oldUrl = storageUrl(oldKey);
    const sharedKey = `${randomUUID()}.png`;
    const sharedUrl = storageUrl(sharedKey);
    const item = await product({ images: [oldUrl, sharedUrl] });
    const other = await product({ images: [sharedUrl] });

    // Replacing the images removes the orphaned object, but the shared
    // image survives because the other product still references it.
    await adminUpdateProduct(item.id, {
      name: item.name,
      categoryId: item.categoryId,
      price: item.price,
      status: "PUBLISHED",
      isFeatured: false,
      images: [storageUrl(`${randomUUID()}.png`)],
      stock: 5,
    });
    expect(mocks.storageRemove).toHaveBeenCalledWith([oldKey]);
    expect(mocks.storageRemove).not.toHaveBeenCalledWith([sharedKey]);

    // The shared image is now orphaned (neither product references it any
    // more), so it is cleaned up; the external hotlink is never touched.
    mocks.storageRemove.mockClear();
    await adminUpdateProduct(other.id, {
      name: other.name,
      categoryId: other.categoryId,
      price: other.price,
      status: "PUBLISHED",
      isFeatured: false,
      images: ["https://example.com/external.png"],
      stock: 5,
    });
    expect(mocks.storageRemove).toHaveBeenCalledTimes(1);
    expect(mocks.storageRemove).toHaveBeenCalledWith([sharedKey]);
  });

  it("cleans up a replaced category image and a deleted category's image", async () => {
    const cat = await category({ imageUrl: storageUrl(`${randomUUID()}.png`) });
    const newKey = `${randomUUID()}.png`;
    await adminUpdateCategory(cat.id, {
      name: cat.name,
      imageUrl: storageUrl(newKey),
      isActive: true,
      sortOrder: 0,
    });
    expect(mocks.storageRemove).toHaveBeenCalledTimes(1);

    mocks.storageRemove.mockClear();
    const doomed = await category({ imageUrl: storageUrl(`${randomUUID()}.png`) });
    await adminDeleteCategory(doomed.id);
    expect(mocks.storageRemove).toHaveBeenCalledTimes(1);

    // A banner object is never touched by media cleanup (banners own it).
    mocks.storageRemove.mockClear();
    const bannerish = await category({
      imageUrl: `${TEST_STORAGE_URL}/storage/v1/object/public/product-images/banners/${randomUUID()}.png`,
    });
    await adminUpdateCategory(bannerish.id, {
      name: bannerish.name,
      imageUrl: storageUrl(`${randomUUID()}.png`),
      isActive: true,
      sortOrder: 0,
    });
    expect(mocks.storageRemove).not.toHaveBeenCalled();
  });
});
