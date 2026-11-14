import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    product: {
      create: vi.fn(),
      update: vi.fn(),
    },
    productImage: {
      deleteMany: vi.fn(),
    },
    inventory: {
      create: vi.fn(),
    },
  };
  const db = {
    product: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  return {
    db,
    tx,
    writeAvailableStock: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/services/reservation-writes", () => ({
  writeAvailableStock: mocks.writeAvailableStock,
}));

import {
  adminCreateProduct,
  adminUpdateProduct,
  type ProductWriteInput,
} from "@/services/products.service";

const orderedImages = [
  "https://example.supabase.co/storage/v1/object/public/product-images/primary.jpg",
  "https://example.supabase.co/storage/v1/object/public/product-images/alternate.jpg",
];

const input: ProductWriteInput = {
  name: "Product Image Test",
  slug: "product-image-test",
  description: "Test description",
  categoryId: "category-1",
  price: 2500,
  comparePrice: 3000,
  status: "PUBLISHED",
  isFeatured: true,
  rating: 4.5,
  reviewCount: 12,
  tags: "test, camera",
  images: orderedImages,
  stock: 7,
  lowStockThreshold: 2,
};

describe("product image persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.product.findFirst.mockResolvedValue(null);
    mocks.db.$transaction.mockImplementation(
      async (operation: (tx: typeof mocks.tx) => Promise<unknown>) =>
        operation(mocks.tx)
    );
    mocks.tx.product.create.mockResolvedValue({ id: "product-1" });
    mocks.tx.product.update.mockResolvedValue({ id: "product-1" });
    mocks.tx.productImage.deleteMany.mockResolvedValue({ count: 0 });
    mocks.tx.inventory.create.mockResolvedValue({ productId: "product-1" });
    mocks.writeAvailableStock.mockResolvedValue(undefined);
  });

  it("creates ordered image records and inventory in the product transaction", async () => {
    await adminCreateProduct(input);

    expect(mocks.db.$transaction).toHaveBeenCalledOnce();
    expect(mocks.tx.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: input.name,
          slug: input.slug,
          categoryId: input.categoryId,
          price: input.price,
          comparePrice: input.comparePrice,
          sku: expect.stringMatching(/^KH-PRO-IMA-TES-\d{2}$/),
          status: input.status,
          isFeatured: input.isFeatured,
          tags: input.tags,
          images: {
            create: [
              { url: orderedImages[0], sortOrder: 0, alt: input.name },
              { url: orderedImages[1], sortOrder: 1, alt: input.name },
            ],
          },
        }),
      })
    );
    expect(mocks.tx.inventory.create).toHaveBeenCalledWith({
      data: {
        productId: "product-1",
        quantity: input.stock,
        lowStockThreshold: input.lowStockThreshold,
      },
    });
  });

  it("replaces the edit image set in primary-first order", async () => {
    await adminUpdateProduct("product-1", {
      ...input,
      images: [orderedImages[1], orderedImages[0]],
    });

    expect(mocks.tx.productImage.deleteMany).toHaveBeenCalledWith({
      where: { productId: "product-1" },
    });
    expect(mocks.tx.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "product-1" },
        data: expect.objectContaining({
          images: {
            create: [
              { url: orderedImages[1], sortOrder: 0, alt: input.name },
              { url: orderedImages[0], sortOrder: 1, alt: input.name },
            ],
          },
        }),
      })
    );
  });
});
