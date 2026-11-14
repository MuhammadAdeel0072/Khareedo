import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entries: new Map<string, { body: string; tags: string[] }>(),
  registrations: [] as { keys: string[]; options: { revalidate: number; tags: string[] } }[],
  events: [] as string[],
  banner: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: { banner: state.banner } }));
vi.mock("next/cache", () => ({
  // Model the service's cache boundary, including Next's JSON storage. These
  // tests check service contracts; production verification measures Next itself.
  unstable_cache: (
    run: (...args: unknown[]) => Promise<unknown>,
    keys: string[],
    options: { revalidate: number; tags: string[] }
  ) => {
    state.registrations.push({ keys, options });
    return async (...args: unknown[]) => {
      const key = JSON.stringify([keys, args]);
      const existing = state.entries.get(key);
      if (existing) return JSON.parse(existing.body);
      const result = await run(...args);
      state.entries.set(key, { body: JSON.stringify(result), tags: options.tags });
      return result;
    };
  },
  revalidateTag: vi.fn((tag: string) => {
    state.events.push("invalidate");
    for (const [key, entry] of state.entries) {
      if (entry.tags.includes(tag)) state.entries.delete(key);
    }
  }),
}));

import { revalidateTag } from "next/cache";
import {
  adminCreateBanner,
  adminDeleteBanner,
  adminListBanners,
  adminUpdateBanner,
  getActiveBanners,
  type BannerWriteInput,
} from "@/services/banners.service";

const input: BannerWriteInput = {
  title: "Summer collection",
  subtitle: "Fresh arrivals",
  imageUrl: "/images/banner.png",
  linkUrl: "/products",
  placement: "HERO",
  isActive: true,
  sortOrder: 3,
};
const original = {
  id: "editorial-banner",
  ...input,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

describe("public editorial banner cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.entries.clear();
    state.events.length = 0;
    state.banner.findMany.mockResolvedValue([original]);
    // adminUpdateBanner/adminDeleteBanner read the previous record first for
    // orphan-safe storage cleanup; the previous URL is not a banners/ storage
    // object, so the cleanup path exits before any storage client is used.
    state.banner.findUnique.mockResolvedValue({ imageUrl: input.imageUrl });
  });

  it("keeps active selection, sorting, default limit and Date values on hits and misses", async () => {
    expect(state.registrations).toEqual([{
      keys: ["storefront-banners"],
      options: { revalidate: 60, tags: ["storefront-banners"] },
    }]);
    const first = await getActiveBanners("HERO");
    const cached = await getActiveBanners("HERO");
    expect(state.banner.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { placement: "HERO", isActive: true },
      orderBy: { sortOrder: "asc" },
      take: 5,
    });
    expect(first).toEqual([original]);
    expect(cached).toEqual(first);
    expect(cached[0].createdAt).toBeInstanceOf(Date);
    expect(cached[0].updatedAt).toBeInstanceOf(Date);
  });

  it("separates every placement and requested limit in the cache key", async () => {
    for (const [placement, limit] of [["HERO", 3], ["SIDE", 2], ["HERO", 2], ["STRIP", 2]] as const) {
      state.banner.findMany.mockResolvedValueOnce([{ ...original, placement, title: `${placement}-${limit}` }]);
      expect((await getActiveBanners(placement, limit))[0].title).toBe(`${placement}-${limit}`);
    }
    for (const [placement, limit] of [["HERO", 3], ["SIDE", 2], ["HERO", 2], ["STRIP", 2]] as const) {
      expect((await getActiveBanners(placement, limit))[0].title).toBe(`${placement}-${limit}`);
    }
    expect(state.banner.findMany).toHaveBeenCalledTimes(4);
  });

  it("expires cached empty lists after creation and preserves the created record", async () => {
    state.banner.findMany.mockResolvedValueOnce([]);
    expect(await getActiveBanners("HERO", 3)).toEqual([]);
    state.banner.create.mockImplementationOnce(async () => {
      state.events.push("create");
      return original;
    });
    expect(await adminCreateBanner(input)).toBe(original);
    expect(state.banner.create).toHaveBeenCalledExactlyOnceWith({ data: input });
    expect(state.events).toEqual(["create", "invalidate"]);
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith("storefront-banners", { expire: 0 });
    expect(await getActiveBanners("HERO", 3)).toEqual([original]);
    expect(state.banner.findMany).toHaveBeenCalledTimes(2);
  });

  it("expires both placements after a move and preserves the updated record", async () => {
    await getActiveBanners("HERO", 3);
    await getActiveBanners("SIDE", 2);
    const moved = { ...original, placement: "SIDE" };
    state.banner.update.mockImplementationOnce(async () => {
      state.events.push("update");
      return moved;
    });
    expect(await adminUpdateBanner(original.id, { ...input, placement: "SIDE" })).toBe(moved);
    expect(state.banner.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: original.id }, data: { ...input, placement: "SIDE" },
    });
    expect(state.events).toEqual(["update", "invalidate"]);
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith("storefront-banners", { expire: 0 });
    await getActiveBanners("HERO", 3);
    await getActiveBanners("SIDE", 2);
    expect(state.banner.findMany).toHaveBeenCalledTimes(4);
  });

  it("expires all limits after deletion and retains the undefined return value", async () => {
    await getActiveBanners("HERO", 3);
    await getActiveBanners("HERO", 5);
    state.banner.delete.mockImplementationOnce(async () => {
      state.events.push("delete");
      return original;
    });
    expect(await adminDeleteBanner(original.id)).toBeUndefined();
    expect(state.banner.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: original.id } });
    expect(state.events).toEqual(["delete", "invalidate"]);
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith("storefront-banners", { expire: 0 });
    state.banner.findMany.mockResolvedValue([]);
    expect(await getActiveBanners("HERO", 3)).toEqual([]);
    expect(await getActiveBanners("HERO", 5)).toEqual([]);
    expect(state.banner.findMany).toHaveBeenCalledTimes(4);
  });

  it.each(["create", "update", "delete"] as const)("does not expire or conceal a failed %s", async (operation) => {
    await getActiveBanners("HERO", 3);
    const failure = new Error("Write failed");
    state.banner[operation].mockRejectedValueOnce(failure);
    const write = operation === "create" ? adminCreateBanner(input)
      : operation === "update" ? adminUpdateBanner(original.id, input)
      : adminDeleteBanner(original.id);
    await expect(write).rejects.toBe(failure);
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(await getActiveBanners("HERO", 3)).toEqual([original]);
    expect(state.banner.findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps the admin listing fresh and retains optional-field normalization", async () => {
    const listing = [original, { ...original, id: "inactive", isActive: false }];
    state.banner.findMany.mockResolvedValue(listing);
    expect(await adminListBanners()).toBe(listing);
    expect(await adminListBanners()).toBe(listing);
    expect(state.banner.findMany).toHaveBeenNthCalledWith(2, {
      orderBy: [{ placement: "asc" }, { sortOrder: "asc" }],
    });
    const { subtitle, linkUrl, ...withoutOptional } = input;
    state.banner.create.mockResolvedValueOnce(original);
    await adminCreateBanner(withoutOptional);
    expect(state.banner.create).toHaveBeenCalledWith({ data: { ...withoutOptional, subtitle: null, linkUrl: null } });
  });
});
