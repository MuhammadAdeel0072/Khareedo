// Orphaned media cleanup for product/category images (Phase 3, Chunk 5).
//
// Mirrors the banner cleanup pattern in src/services/banners.service.ts:
// when a product or category image is replaced or removed, the storage
// object behind the old URL is deleted — but ONLY when it is one of our own
// storage objects AND no product image or category still references the
// same URL. Never throws: a failed cleanup must not break the admin
// operation, it just leaves a harmless unreferenced object behind.
import { db } from "@/lib/db";
import { getStorageClient, parseMediaStorageObjectPath, MEDIA_BUCKET } from "@/lib/storage";

export async function cleanupOrphanedMediaImage(imageUrl: string | null | undefined): Promise<void> {
  try {
    const objectKey = parseMediaStorageObjectPath(imageUrl);
    if (!objectKey) return; // external hotlink, banner object, or legacy path — never touched

    const [productRefs, categoryRefs] = await Promise.all([
      db.productImage.count({ where: { url: imageUrl! } }),
      db.category.count({ where: { imageUrl: imageUrl! } }),
    ]);
    if (productRefs + categoryRefs > 0) return; // still in use — shared images are protected

    const supabase = getStorageClient();
    if (!supabase) return; // storage not configured in this environment — skip quietly

    const { error } = await supabase.storage.from(MEDIA_BUCKET).remove([objectKey]);
    if (error) {
      console.warn("[media-cleanup] orphaned image cleanup failed:", error.message);
    }
  } catch (error) {
    console.warn(
      "[media-cleanup] orphaned image cleanup skipped:",
      error instanceof Error ? error.message : "unknown",
    );
  }
}
