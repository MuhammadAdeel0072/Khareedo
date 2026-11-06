import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TestAuthError extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message);
    }
  }

  return {
    TestAuthError,
    requireAdmin: vi.fn(),
    categoryFindUnique: vi.fn(),
    adminCreateProduct: vi.fn(),
    adminUpdateProduct: vi.fn(),
    storageFrom: vi.fn(),
    storageUpload: vi.fn(),
    getPublicUrl: vi.fn(),
  };
});

vi.mock("@/lib/auth-guard", () => ({
  AuthError: mocks.TestAuthError,
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/db", () => ({
  db: { category: { findUnique: mocks.categoryFindUnique } },
}));
vi.mock("@/services/products.service", () => ({
  adminCreateProduct: mocks.adminCreateProduct,
  adminUpdateProduct: mocks.adminUpdateProduct,
  adminGetProduct: vi.fn(),
  adminArchiveProduct: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    storage: { from: mocks.storageFrom },
  })),
}));

import { Prisma } from "../../generated/postgres-client";
import { POST as uploadImage } from "@/app/api/admin/upload/route";
import { POST as createProduct } from "@/app/api/admin/products/route";
import { PUT as updateProduct } from "@/app/api/admin/products/[id]/route";
import { readAdminApiResponse, adminApiErrorMessage } from "@/lib/admin-api-response";
import { getProductImageExtension } from "@/lib/product-image-validation";

const category = { id: "category-1" };
const product = { id: "product-1", name: "Test Product" };

function bytes(...values: number[]) {
  return new Uint8Array(values);
}

function productInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Product",
    categoryId: category.id,
    price: 100,
    comparePrice: null,
    status: "PUBLISHED",
    isFeatured: false,
    rating: 0,
    reviewCount: 0,
    images: ["https://example.com/one.jpg"],
    stock: 3,
    lowStockThreshold: 5,
    ...overrides,
  };
}

function imageRequest(file: File) {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://localhost/api/admin/upload", {
    method: "POST",
    body: form,
  });
}

async function responseJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("admin product image upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
    mocks.requireAdmin.mockResolvedValue(undefined);
    mocks.storageUpload.mockResolvedValue({ error: null });
    mocks.getPublicUrl.mockImplementation((path: string) => ({
      data: {
        publicUrl: `https://example.supabase.co/storage/v1/object/public/product-images/${path}`,
      },
    }));
    mocks.storageFrom.mockReturnValue({
      upload: mocks.storageUpload,
      getPublicUrl: mocks.getPublicUrl,
    });
  });

  it.each([
    ["image/jpeg", "jpg", bytes(0xff, 0xd8, 0xff, 0x00)],
    ["image/png", "png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ["image/webp", "webp", bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50)],
    ["image/gif", "gif", new TextEncoder().encode("GIF89a")],
  ])("accepts valid %s content and returns its public URL", async (mime, extension, content) => {
    expect(getProductImageExtension(content, mime)).toBe(extension);
    const response = await uploadImage(
      imageRequest(new File([content], "untrusted-name.bin", { type: mime }))
    );
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
    });
    expect(body.url).toMatch(
      new RegExp(
        `^https://example\\.supabase\\.co/storage/v1/object/public/product-images/[0-9a-f-]+\\.${extension}$`
      )
    );
    expect(mocks.storageFrom).toHaveBeenCalledWith("product-images");
    expect(mocks.storageUpload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^[0-9a-f-]+\\.${extension}$`)),
      expect.any(Blob),
      expect.objectContaining({ contentType: mime, upsert: false })
    );
  });

  it("rejects unauthenticated and non-admin upload requests", async () => {
    for (const status of [401, 403]) {
      mocks.requireAdmin.mockRejectedValueOnce(
        new mocks.TestAuthError("Not authorized", status)
      );
      const response = await uploadImage(
        imageRequest(new File([bytes(0xff, 0xd8, 0xff)], "a.jpg", { type: "image/jpeg" }))
      );
      expect(response.status).toBe(status);
    }
    expect(mocks.storageUpload).not.toHaveBeenCalled();
  });

  it("rejects invalid, mismatched, empty, and oversized files", async () => {
    const cases = [
      [new File(["not an image"], "x.jpg", { type: "image/jpeg" }), 415],
      [new File([bytes(0xff, 0xd8, 0xff)], "x.png", { type: "image/png" }), 415],
      [new File([bytes(0xff, 0xd8, 0xff)], "x.jpg", { type: "text/plain" }), 415],
      [new File([], "empty.jpg", { type: "image/jpeg" }), 400],
      [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" }), 413],
    ] as const;

    for (const [file, status] of cases) {
      const response = await uploadImage(imageRequest(file));
      expect(response.status).toBe(status);
    }
    expect(mocks.storageUpload).not.toHaveBeenCalled();
  });

  it("rejects oversized multipart bodies before parsing", async () => {
    const body = new Uint8Array(5 * 1024 * 1024 + 65 * 1024);
    const request = new Request("http://localhost/api/admin/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=large" },
      body,
    });

    const response = await uploadImage(request);
    expect(response.status).toBe(413);
    expect(mocks.storageUpload).not.toHaveBeenCalled();
  });
});

describe("admin product create and edit APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(undefined);
    mocks.categoryFindUnique.mockResolvedValue(category);
    mocks.adminCreateProduct.mockResolvedValue(product);
    mocks.adminUpdateProduct.mockResolvedValue(product);
  });

  it("creates a valid product with its image order and stock", async () => {
    const input = productInput({
      images: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
    });
    const response = await createProduct(
      new Request("http://localhost/api/admin/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({ ok: true, product });
    expect(mocks.adminCreateProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: category.id,
        images: input.images,
        stock: 3,
      })
    );
  });

  it.each([
    ["missing images", productInput({ images: [] }), "images"],
    ["invalid price", productInput({ price: 0 }), "price"],
    ["non-integer price", productInput({ price: 10.5 }), "price"],
    ["invalid compare price", productInput({ comparePrice: 100 }), "comparePrice"],
    ["zero compare price", productInput({ comparePrice: 0 }), "comparePrice"],
    ["invalid status", productInput({ status: "LIVE" }), "status"],
  ])("rejects %s with a field validation error", async (_case, input, field) => {
    const response = await createProduct(
      new Request("http://localhost/api/admin/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
    );

    expect(response.status).toBe(422);
    expect((await responseJson(response)).errors).toHaveProperty(field);
    expect(mocks.adminCreateProduct).not.toHaveBeenCalled();
  });

  it("returns a field-specific error for an unknown category", async () => {
    mocks.categoryFindUnique.mockResolvedValue(null);
    const response = await createProduct(
      new Request("http://localhost/api/admin/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(productInput()),
      })
    );

    expect(response.status).toBe(422);
    expect((await responseJson(response)).errors).toHaveProperty("categoryId");
    expect(mocks.adminCreateProduct).not.toHaveBeenCalled();
  });

  it("maps duplicate SKU constraints to a conflict response", async () => {
    mocks.adminCreateProduct.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Duplicate SKU", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["sku"] },
      })
    );
    const response = await createProduct(
      new Request("http://localhost/api/admin/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(productInput()),
      })
    );

    expect(response.status).toBe(409);
    expect((await responseJson(response)).errors).toHaveProperty("sku");
  });

  it("updates product fields, ordered images, and inventory", async () => {
    const input = productInput({
      name: "Updated Product",
      images: ["https://example.com/retained.jpg", "https://example.com/added.jpg"],
      stock: 8,
      lowStockThreshold: 2,
    });
    const response = await updateProduct(
      new Request("http://localhost/api/admin/products/product-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ id: "product-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.adminUpdateProduct).toHaveBeenCalledWith(
      "product-1",
      expect.objectContaining({
        name: "Updated Product",
        images: input.images,
        stock: 8,
        lowStockThreshold: 2,
      })
    );
  });
});

describe("admin API response handling", () => {
  it.each([
    [401, /session has expired/i],
    [403, /permission/i],
    [413, /too large/i],
    [415, /format is not supported/i],
    [422, /highlighted fields/i],
    [500, /server could not complete/i],
  ])("turns HTML %s responses into useful errors", async (status, message) => {
    const response = new Response("<html>unexpected page</html>", {
      status,
      headers: { "content-type": "text/html" },
    });
    const data = await readAdminApiResponse(response);

    expect(data.ok).toBe(false);
    expect(adminApiErrorMessage(response, data)).toMatch(message);
  });
});
