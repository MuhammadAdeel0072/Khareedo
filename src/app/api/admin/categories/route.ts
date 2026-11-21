// Admin: category create (FR-40).
import { adminCreateCategory } from "@/services/categories.service";
import { categorySchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import { categoryWriteErrorResponse } from "@/lib/category-api-errors";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-categories-write:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const parsed = await parseBody(request, categorySchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    try {
      const category = await adminCreateCategory({
        name: d.name,
        slug: d.slug || undefined,
        description: d.description || undefined,
        imageUrl: d.imageUrl || undefined,
        parentId: d.parentId || null,
        isActive: d.isActive,
        sortOrder: d.sortOrder,
      });
      await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
        action: ADMIN_AUDIT_ACTIONS.CATEGORY_CREATED,
        targetType: "Category",
        targetId: category.id,
        metadata: { name: d.name },
      });
      return jsonOk({ category });
    } catch (error) {
      const response = categoryWriteErrorResponse(error);
      if (response) return response;
      throw error;
    }
  });
}
