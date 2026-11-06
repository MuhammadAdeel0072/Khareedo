import { setImmediate } from "node:timers/promises";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductListItem } from "@/services/products.service";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { $queryRaw: query } }));

const service = vi.hoisted(() => ({
  banners: vi.fn(), categories: vi.fn(), catalog: vi.fn(),
  user: vi.fn(), wishlist: vi.fn(), settings: vi.fn(),
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/image", () => ({ default: vi.fn(() => null) }));
vi.mock("next/link", () => ({ default: vi.fn(() => null) }));
vi.mock("@/components/home/hero-carousel", () => ({ HeroCarousel: vi.fn(() => null) }));
vi.mock("@/components/products/product-card", () => ({ ProductCard: vi.fn(() => null) }));
vi.mock("@/components/ui/button", () => ({ Button: vi.fn(() => null) }));
vi.mock("@/services/banners.service", () => ({ getActiveBanners: service.banners }));
vi.mock("@/services/categories.service", () => ({ getCategoriesWithCounts: service.categories }));
vi.mock("@/services/products.service", () => ({ getHomepageCatalog: service.catalog }));
vi.mock("@/services/promotions.service", () => ({
  describePromotion: () => "Fixture offer",
}));
vi.mock("@/services/wishlist.service", () => ({ getWishlistProductIds: service.wishlist }));
vi.mock("@/services/settings.service", () => ({ getSettings: service.settings }));
vi.mock("@/lib/auth-guard", () => ({ getSessionUser: service.user }));

import HomePage from "@/app/(store)/page";
import { ProductCard } from "@/components/products/product-card";
import { HeroCarousel } from "@/components/home/hero-carousel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

const featured: ProductListItem = {
  id: "featured-fixture", name: "Current price watch", slug: "fixture-watch",
  price: 2199, comparePrice: 2599, brand: "Fixture", rating: 4.5, reviewCount: 8,
  image: "/fixture-watch.png", stock: 3, isFeatured: true, status: "PUBLISHED",
  createdAt: new Date("2026-11-04T00:00:00Z"), categoryName: "Watches", categorySlug: "watches",
};
const arrival = { ...featured, id: "arrival-fixture", name: "Unavailable fixture", stock: 0, price: 1799 };
const user = { id: "verified-customer", email: "fixture@example.test", name: "Fixture", role: "CUSTOMER" };

describe("homepage request dependencies and personalization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    service.banners.mockImplementation(async (placement: string) => [{
      id: `${placement}-fixture`, title: "Fixture banner", subtitle: null,
      imageUrl: "/fixture-banner.png", linkUrl: "/products",
    }]);
    service.categories.mockResolvedValue([{
      id: "category-fixture", name: "Watches", slug: "watches", imageUrl: null, productCount: 2,
    }]);
    service.catalog.mockResolvedValue({
      featured: [featured], newArrivals: [arrival],
      promotions: [{ id: "offer-fixture", title: "Current offer", description: "Fixture" }],
    });
    service.user.mockResolvedValue(user);
    service.wishlist.mockResolvedValue([featured.id]);
    // The layout owns settings. A homepage dependency must fail this test.
    service.settings.mockRejectedValue(new Error("Homepage must not retrieve unused settings"));
  });

  it("starts the authenticated wishlist while an independent public read is still pending", async () => {
    const publicRead = deferred<{ featured: ProductListItem[]; newArrivals: ProductListItem[]; promotions: never[] }>();
    service.catalog.mockReturnValue(publicRead.promise);
    const render = HomePage();
    try {
      // Let all already-resolved promise chains settle without resolving the
      // deliberately blocked public read or depending on wall-clock latency.
      await setImmediate();
      expect(service.wishlist).toHaveBeenCalledExactlyOnceWith(user.id);
    } finally {
      publicRead.resolve({ featured: [featured], newArrivals: [arrival], promotions: [] });
      await render;
    }
  });

  it("retains current product data, personal wishlist state, banners and every homepage section", async () => {
    const tree = elements(await HomePage());
    const cards = tree.filter(element => element.type === ProductCard);
    expect(cards).toHaveLength(2);
    expect(cards[0].props).toMatchObject({ product: featured, wished: true, isSignedIn: true });
    expect(cards[1].props).toMatchObject({ product: arrival, wished: false, isSignedIn: true });
    // Identity preserves the exact live service view model, including stock and
    // prices, rather than a transformed or stale fixture copy.
    expect(cards[0].props.product).toBe(featured);
    expect(cards[1].props.product).toBe(arrival);
    expect(tree.filter(element => element.type === "section").map(element => element.props["aria-label"])).toEqual([
      "Featured promotions", "Shop by category", "Current offers", "Featured products", "New arrivals",
    ]);
    expect(tree.find(element => element.type === HeroCarousel)?.props.banners).toEqual([{
      id: "HERO-fixture", title: "Fixture banner", subtitle: null,
      imageUrl: "/fixture-banner.png", linkUrl: "/products",
    }]);
    expect(service.banners.mock.calls).toEqual([["HERO", 3], ["SIDE", 2]]);
    expect(service.catalog).toHaveBeenCalledExactlyOnceWith();
    expect(service.settings).not.toHaveBeenCalled();
  });

  it("skips private wishlist reads for a guest and keeps their product controls signed out", async () => {
    service.user.mockResolvedValue(null);
    const cards = elements(await HomePage()).filter(element => element.type === ProductCard);
    expect(service.wishlist).not.toHaveBeenCalled();
    for (const card of cards) expect(card.props).toMatchObject({ wished: false, isSignedIn: false });
  });

  it("waits for wishlist resolution before returning personalized product controls", async () => {
    const wishlist = deferred<string[]>();
    service.wishlist.mockReturnValue(wishlist.promise);
    let rendered = false;
    const render = HomePage().then(tree => { rendered = true; return tree; });
    await setImmediate();
    expect(rendered).toBe(false);
    wishlist.resolve([arrival.id]);
    const cards = elements(await render).filter(element => element.type === ProductCard);
    expect(cards[0].props.wished).toBe(false);
    expect(cards[1].props.wished).toBe(true);
  });

  it("propagates failed user verification without reading another user's wishlist", async () => {
    const failure = new Error("User verification failed");
    service.user.mockRejectedValue(failure);
    await expect(HomePage()).rejects.toBe(failure);
    expect(service.wishlist).not.toHaveBeenCalled();
  });
});

const catalogProduct = {
  id: "fixture", name: "Fixture", slug: "fixture", price: 1234, comparePrice: null,
  brand: null, rating: 4.2, reviewCount: 3, status: "PUBLISHED", isFeatured: true,
  createdAt: "2026-11-04T12:00:00+00:00", image: null, stock: 0,
  categoryName: "Fixture", categorySlug: "fixture",
};
const promotion = {
  id: "offer", title: "Offer", description: null, type: "FIXED", value: 10,
  minOrderAmount: null, isActive: true, startsAt: null, endsAt: "2026-12-01T00:00:00+00:00",
  createdAt: "2026-11-04T00:00:00+00:00", updatedAt: "2026-11-04T00:00:00+00:00",
};

describe("live homepage catalogue batch", () => {
  let getHomepageCatalog: typeof import("@/services/products.service").getHomepageCatalog;
  beforeAll(async () => {
    ({ getHomepageCatalog } = await vi.importActual<typeof import("@/services/products.service")>("@/services/products.service"));
  });
  beforeEach(() => { query.mockReset(); });

  it("uses one read and retains overlapping products, current stock/prices and UTC Date values", async () => {
    query.mockResolvedValue([{ featured: [catalogProduct], newArrivals: [catalogProduct], promotions: [promotion] }]);
    const result = await getHomepageCatalog();
    expect(query).toHaveBeenCalledTimes(1);
    const [template, ...parameters] = query.mock.calls[0];
    expect(Array.isArray(template)).toBe(true);
    expect(template.join("")).toContain("WITH featured AS");
    expect(parameters).toHaveLength(template.length - 1);
    expect(result.featured[0]).toEqual({ ...catalogProduct, createdAt: new Date(catalogProduct.createdAt) });
    expect(result.newArrivals).toEqual(result.featured);
    expect(result.promotions[0]).toEqual({ ...promotion,
      createdAt: new Date(promotion.createdAt), updatedAt: new Date(promotion.updatedAt),
      endsAt: new Date(promotion.endsAt),
    });
  });

  it("keeps empty sections empty", async () => {
    query.mockResolvedValue([{ featured: [], newArrivals: [], promotions: [] }]);
    expect(await getHomepageCatalog()).toEqual({ featured: [], newArrivals: [], promotions: [] });
  });

  it("reads again on every call so changed prices, stock and expired offers are visible", async () => {
    query.mockResolvedValueOnce([{ featured: [catalogProduct], newArrivals: [], promotions: [promotion] }])
      .mockResolvedValueOnce([{ featured: [{ ...catalogProduct, price: 2345, stock: 7 }], newArrivals: [], promotions: [] }]);
    const first = await getHomepageCatalog();
    const second = await getHomepageCatalog();
    expect(query).toHaveBeenCalledTimes(2);
    expect(first.featured[0].price).toBe(1234);
    expect(second.featured[0]).toMatchObject({ price: 2345, stock: 7 });
    expect(second.promotions).toEqual([]);
  });

  it("propagates database failures without serving a stale fallback", async () => {
    const error = new Error("Database unavailable");
    query.mockRejectedValue(error);
    await expect(getHomepageCatalog()).rejects.toBe(error);
  });
});
