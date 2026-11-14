// Unit tests — banner storage cleanup (orphan-safe rule).
//
// The cleanup behind banner update/delete must:
//  1. only ever touch OUR storage objects under the "banners/" key prefix;
//  2. never delete an object that another banner still references;
//  3. never throw — a storage outage must not fail the admin operation.
import { beforeEach, afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  banner: {
    count: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

const removeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: dbMock }));

// banners.service calls revalidateTag on every admin write; outside a Next.js
// request scope that throws, so the cache module is stubbed (same convention
// as admin-performance.test.ts).
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage")>("@/lib/storage");
  return {
    ...actual,
    MEDIA_BUCKET: "product-images",
    BANNER_IMAGE_PREFIX: "banners",
    getStorageClient: () => ({
      storage: { from: () => ({ remove: removeMock }) },
    }),
  };
});

import {
  adminUpdateBanner,
  adminDeleteBanner,
} from "@/services/banners.service";

const STORAGE_BASE =
  "https://proj.supabase.co/storage/v1/object/public/product-images";

// Storage config is read at test-RUN time (cleanup runs inside the request-
// like operation), so env is set in beforeAll/afterAll hooks rather than
// around describe registration.
function useStorageEnv() {
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  });
  afterAll(() => {
    if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
  afterEach(() => {
    vi.clearAllMocks();
    removeMock.mockReset();
  });
}

const UPDATED_BANNER = {
  id: "b1",
  title: "t",
  subtitle: null,
  imageUrl: `${STORAGE_BASE}/banners/new.png`,
  linkUrl: null,
  placement: "HERO" as const,
  isActive: true,
  sortOrder: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("banner update cleanup", () => {
    useStorageEnv();
    beforeEach(async () => {
      dbMock.banner.update.mockResolvedValue(UPDATED_BANNER);
    });

    it("deletes the replaced object when no other banner references it", async () => {
      dbMock.banner.findUnique.mockResolvedValue({ imageUrl: `${STORAGE_BASE}/banners/old.png` });
      dbMock.banner.count.mockResolvedValue(0);
      removeMock.mockResolvedValue({ error: null });

      await adminUpdateBanner("b1", {
        title: "t",
        imageUrl: UPDATED_BANNER.imageUrl,
        placement: "HERO",
        isActive: true,
        sortOrder: 1,
      });

      expect(removeMock).toHaveBeenCalledWith(["banners/old.png"]);
    });

    it("protects the old object while another banner still references it", async () => {
      dbMock.banner.findUnique.mockResolvedValue({ imageUrl: `${STORAGE_BASE}/banners/shared.png` });
      dbMock.banner.count.mockResolvedValue(1);

      await adminUpdateBanner("b1", {
        title: "t",
        imageUrl: UPDATED_BANNER.imageUrl,
        placement: "HERO",
        isActive: true,
        sortOrder: 1,
      });

      expect(removeMock).not.toHaveBeenCalled();
    });

    it("never touches external hotlinks or non-banner paths", async () => {
      dbMock.banner.findUnique.mockResolvedValue({
        imageUrl: "https://images.example.com/some-banner.jpg",
      });

      await adminUpdateBanner("b1", {
        title: "t",
        imageUrl: UPDATED_BANNER.imageUrl,
        placement: "HERO",
        isActive: true,
        sortOrder: 1,
      });

      expect(dbMock.banner.count).not.toHaveBeenCalled();
      expect(removeMock).not.toHaveBeenCalled();
    });

    it("does not fail the update when storage cleanup throws", async () => {
      dbMock.banner.findUnique.mockResolvedValue({ imageUrl: `${STORAGE_BASE}/banners/old.png` });
      dbMock.banner.count.mockResolvedValue(0);
      removeMock.mockRejectedValue(new Error("storage down"));

      await expect(
        adminUpdateBanner("b1", {
          title: "t",
          imageUrl: UPDATED_BANNER.imageUrl,
          placement: "HERO",
          isActive: true,
          sortOrder: 1,
        })
      ).resolves.toMatchObject({ id: "b1" });
    });
  });

describe("banner delete cleanup", () => {
    useStorageEnv();
    it("deletes the orphaned object after the row is removed", async () => {
      dbMock.banner.findUnique.mockResolvedValue({ imageUrl: `${STORAGE_BASE}/banners/gone.png` });
      dbMock.banner.delete.mockResolvedValue(UPDATED_BANNER);
      dbMock.banner.count.mockResolvedValue(0);
      removeMock.mockResolvedValue({ error: null });

      await adminDeleteBanner("b1");

      expect(dbMock.banner.delete).toHaveBeenCalledWith({ where: { id: "b1" } });
      expect(removeMock).toHaveBeenCalledWith(["banners/gone.png"]);
    });

    it("skips cleanup for root-relative paths (legacy/public assets)", async () => {
      dbMock.banner.findUnique.mockResolvedValue({ imageUrl: "/images/banners/hero-main.png" });
      dbMock.banner.delete.mockResolvedValue(UPDATED_BANNER);

      await adminDeleteBanner("b1");

      expect(removeMock).not.toHaveBeenCalled();
    });

    it("skips cleanup entirely when storage is not configured", async () => {
      const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      try {
        dbMock.banner.findUnique.mockResolvedValue({ imageUrl: `${STORAGE_BASE}/banners/x.png` });
        dbMock.banner.delete.mockResolvedValue(UPDATED_BANNER);

        await adminDeleteBanner("b1");

        expect(removeMock).not.toHaveBeenCalled();
      } finally {
        if (prevUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
        if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
      }
    });
  });
