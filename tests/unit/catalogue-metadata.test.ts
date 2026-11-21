// Unit test — catalogue metadata helpers (Phase 3, Chunk 5).
//
// The empty-catalogue default (max price 50000, no brands) cannot be tested
// on the shared disposable SQLite database: other integration suites seed
// products into the same database, so "empty" is never observable there.
// These tests mock only the Prisma aggregate/findMany boundary and verify
// the helpers' own logic: the 50000 default, rounding up to the next 500,
// and filtering out null/blank brands.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    product: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({ db: mocks.db }));

import { getCatalogueBrands, getCatalogueMaxPrice } from "@/services/products.service";

describe("catalogue metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults the price cap to 50000 on an empty catalogue", async () => {
    mocks.db.product.aggregate.mockResolvedValue({ _max: { price: null } });
    expect(await getCatalogueMaxPrice()).toBe(50000);
  });

  it("rounds the max price up to the next 500", async () => {
    mocks.db.product.aggregate.mockResolvedValue({ _max: { price: 44999 } });
    expect(await getCatalogueMaxPrice()).toBe(45000);
    mocks.db.product.aggregate.mockResolvedValue({ _max: { price: 50000 } });
    expect(await getCatalogueMaxPrice()).toBe(50000);
    mocks.db.product.aggregate.mockResolvedValue({ _max: { price: 1 } });
    expect(await getCatalogueMaxPrice()).toBe(500);
  });

  it("lists distinct non-blank brands", async () => {
    mocks.db.product.findMany.mockResolvedValue([
      { brand: "Acme" },
      { brand: null },
      { brand: "   " },
      { brand: "Zeta" },
    ]);
    expect(await getCatalogueBrands()).toEqual(["Acme", "Zeta"]);
  });
});
